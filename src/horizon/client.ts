import { HorizonHttpError, HorizonRetryLimitError, HorizonTimeoutError } from './errors.ts';
import type {
  HorizonEffect,
  HorizonOperation,
  HorizonPage,
  HorizonRecord,
  HorizonTrade,
  PagingParams,
} from './types.ts';

export interface HorizonClientOptions {
  /** Horizon base URL, e.g. https://horizon-testnet.stellar.org */
  readonly baseUrl: string;
  /** Retries per request, beyond the first attempt. Default 5. */
  readonly maxRetries?: number;
  /** Per-attempt timeout in ms. Default 30_000. */
  readonly requestTimeoutMs?: number;
  /** Deadline covering all attempts for one request, in ms. Default 120_000. */
  readonly totalTimeoutMs?: number;
  /** First backoff step in ms; doubles per attempt. Default 250. */
  readonly baseDelayMs?: number;
  /** Ceiling for a single backoff wait, in ms. Default 10_000. */
  readonly maxDelayMs?: number;

  // Injected for tests. Production uses the global fetch, a real timer, and
  // Math.random; tests replace the clock and the jitter source so backoff can be
  // asserted deterministically without actually waiting.
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

interface ResolvedOptions {
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly requestTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly now: () => number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a Retry-After header, which may be seconds or an HTTP date.
 *
 * Returns undefined when absent or unparseable, letting the caller fall back to
 * computed backoff rather than treating a malformed header as "retry immediately".
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;

  const trimmed = header.trim();
  if (trimmed === '') return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;

  // A date in the past means retry now, not a negative wait.
  return Math.max(0, date - nowMs);
}

export class HorizonClient {
  readonly #options: ResolvedOptions;

  constructor(options: HorizonClientOptions) {
    this.#options = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      maxRetries: options.maxRetries ?? 5,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      totalTimeoutMs: options.totalTimeoutMs ?? 120_000,
      baseDelayMs: options.baseDelayMs ?? 250,
      maxDelayMs: options.maxDelayMs ?? 10_000,
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
    };
  }

  /**
   * Full jitter: wait a random duration in [0, capped exponential backoff].
   *
   * Jitter matters more than the exponential part here. Three ingestion jobs polling
   * the same Horizon will hit a rate limit at nearly the same moment, and undithered
   * backoff would march them in lockstep into the next limit together.
   */
  #backoffDelay(attempt: number): number {
    const exponential = this.#options.baseDelayMs * 2 ** attempt;
    return Math.floor(this.#options.random() * Math.min(exponential, this.#options.maxDelayMs));
  }

  /** Perform one GET with retries, returning the parsed body. */
  async #getJson<T>(url: string): Promise<T> {
    const {
      fetch: doFetch,
      maxRetries,
      now,
      requestTimeoutMs,
      sleep,
      totalTimeoutMs,
    } = this.#options;

    const startedAt = now();
    const deadline = startedAt + totalTimeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (now() >= deadline) {
        throw new HorizonTimeoutError(url, now() - startedAt, { cause: lastError });
      }

      let response: Response;
      try {
        response = await doFetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch (error) {
        // Network-level failure: DNS, connection reset, per-attempt abort. Worth
        // retrying, unlike a 4xx.
        lastError = error;
        const delay = this.#backoffDelay(attempt);
        if (attempt === maxRetries) break;
        if (now() + delay >= deadline) {
          throw new HorizonTimeoutError(url, now() - startedAt, { cause: error });
        }
        await sleep(delay);
        continue;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      const body = await response.text().catch(() => '');

      // 4xx other than 429 will fail identically however many times we ask. Retrying
      // a malformed cursor just delays the error and burns rate limit.
      if (!RETRYABLE_STATUS.has(response.status)) {
        throw new HorizonHttpError(response.status, url, body.slice(0, 500));
      }

      lastError = new HorizonHttpError(response.status, url, body.slice(0, 500));
      if (attempt === maxRetries) break;

      // Horizon's own Retry-After wins over our computed backoff: it knows when the
      // rate limit window resets and we are guessing.
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), now());
      const delay = retryAfter ?? this.#backoffDelay(attempt);

      if (now() + delay >= deadline) {
        throw new HorizonTimeoutError(url, now() - startedAt, { cause: lastError });
      }
      await sleep(delay);
    }

    throw new HorizonRetryLimitError(maxRetries + 1, url, { cause: lastError });
  }

  #buildUrl(path: string, params: Readonly<Record<string, string | number | undefined>>): string {
    const url = new URL(`${this.#options.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Fetch a single page. Exposed mainly so callers can inspect `_links`. */
  async getPage<T extends HorizonRecord>(
    path: string,
    params: PagingParams & Readonly<Record<string, string | number | undefined>> = {},
  ): Promise<HorizonPage<T>> {
    return await this.#getJson<HorizonPage<T>>(this.#buildUrl(path, params));
  }

  /**
   * Stream every record from a paged collection, following cursors.
   *
   * Yields records rather than pages so callers never hold a whole range in memory,
   * which matters for backfills over a long ledger range.
   *
   * Termination is by empty page, not by absence of a `next` link. Horizon returns a
   * `next` link on the final page too, pointing at a cursor with nothing after it, so
   * trusting the link alone loops forever against a live endpoint.
   */
  async *paginate<T extends HorizonRecord>(
    path: string,
    params: PagingParams & Readonly<Record<string, string | number | undefined>> = {},
  ): AsyncGenerator<T, void, undefined> {
    let cursor = params.cursor;

    for (;;) {
      const page = await this.getPage<T>(path, { ...params, cursor });
      const records = page._embedded.records;

      if (records.length === 0) return;

      for (const record of records) {
        yield record;
      }

      // Advance from the last record's paging_token rather than parsing the `next`
      // href. Both point at the same place, but the token is a documented field
      // while the href is a URL whose shape we would be reverse-engineering.
      const last = records[records.length - 1];
      if (last === undefined || last.paging_token === cursor) return;
      cursor = last.paging_token;
    }
  }

  operations(
    params: PagingParams & Readonly<Record<string, string | number | undefined>> = {},
  ): AsyncGenerator<HorizonOperation, void, undefined> {
    return this.paginate<HorizonOperation>('/operations', params);
  }

  effects(
    params: PagingParams & Readonly<Record<string, string | number | undefined>> = {},
  ): AsyncGenerator<HorizonEffect, void, undefined> {
    return this.paginate<HorizonEffect>('/effects', params);
  }

  trades(
    params: PagingParams & Readonly<Record<string, string | number | undefined>> = {},
  ): AsyncGenerator<HorizonTrade, void, undefined> {
    return this.paginate<HorizonTrade>('/trades', params);
  }
}
