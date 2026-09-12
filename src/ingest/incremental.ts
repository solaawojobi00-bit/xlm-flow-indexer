import type { SqlAdapter } from '../db/adapter.ts';
import type { HorizonClient } from '../horizon/client.ts';
import type { LedgerRange } from './payments.ts';
import { ingestPayments } from './payments.ts';
import { ingestTrades } from './trades.ts';
import { ingestTrustlines } from './trustlines.ts';
import { lastIngestedLedger, recordIngestedLedger, type IngestJob } from './state.ts';

/**
 * Incremental (delta) ingestion, issue #52.
 *
 * Phase 1 re-ingested an explicit full range on every run. This resumes each
 * job from its own watermark in `ingest_state` and reuses the very same
 * range-based ingestion functions — a delta pass is just a narrow range, so
 * there is no second ingestion code path to keep in step with the first. That
 * is also what makes the documented backfill procedure work: it is the ordinary
 * `ingest` command over an explicit range, against the same statements.
 */

/**
 * How far behind the chain head to stop.
 *
 * The most recent ledgers are the ones most likely to be incompletely indexed
 * by the Horizon instance being read — its own ingestion is asynchronous, so
 * `/ledgers?order=desc` can report a sequence whose operations are not all
 * queryable yet. Treating the head as final would advance the watermark past
 * records that were never read, and because the watermark only moves forward
 * those records would never be picked up. Stopping short costs a few seconds of
 * latency and removes that class of silent gap.
 */
export const DEFAULT_CONFIRMATION_LAG = 5;

/**
 * Most ledgers to cover in a single pass.
 *
 * Bounds the work per tick so a long outage does not turn the next tick into an
 * unbounded catch-up that holds a transaction open for minutes. Successive
 * ticks walk forward until the backlog is drained.
 */
export const DEFAULT_MAX_LEDGERS_PER_PASS = 200;

export interface IncrementalOptions {
  /** Where to begin when a job has no recorded watermark. */
  readonly startLedger?: number | undefined;
  readonly confirmationLag?: number | undefined;
  readonly maxLedgersPerPass?: number | undefined;
}

/**
 * The range a job should process next, or `undefined` if it is already current.
 *
 * Pure and separated from the ingestion call on purpose: the interesting
 * behaviour of incremental ingestion is the arithmetic — resuming, clamping to
 * the confirmation lag, capping the pass, refusing to run backwards — and
 * keeping it a pure function means all of that is testable without Horizon or a
 * database.
 */
export function nextRange(
  lastLedger: number | undefined,
  latestLedger: number,
  options: IncrementalOptions = {},
): LedgerRange | undefined {
  const lag = options.confirmationLag ?? DEFAULT_CONFIRMATION_LAG;
  const maxPass = options.maxLedgersPerPass ?? DEFAULT_MAX_LEDGERS_PER_PASS;

  if (!Number.isInteger(lag) || lag < 0) {
    throw new RangeError(`confirmationLag must be a non-negative integer, got ${String(lag)}`);
  }
  if (!Number.isInteger(maxPass) || maxPass < 1) {
    throw new RangeError(`maxLedgersPerPass must be a positive integer, got ${String(maxPass)}`);
  }

  const safeHead = latestLedger - lag;

  let fromLedger: number;
  if (lastLedger === undefined) {
    if (options.startLedger === undefined) {
      throw new Error(
        'No recorded watermark for this job and no startLedger given. Pass an explicit ' +
          'start so the first poll cannot silently skip history, or run a backfill first.',
      );
    }
    if (!Number.isInteger(options.startLedger) || options.startLedger < 1) {
      throw new RangeError(
        `startLedger must be a positive integer, got ${String(options.startLedger)}`,
      );
    }
    fromLedger = options.startLedger;
  } else {
    fromLedger = lastLedger + 1;
  }

  // Nothing new that is old enough to trust yet.
  if (fromLedger > safeHead) return undefined;

  return { fromLedger, toLedger: Math.min(safeHead, fromLedger + maxPass - 1) };
}

export interface IncrementalPassResult {
  readonly job: IngestJob;
  /** The range processed, or undefined if the job was already current. */
  readonly range: LedgerRange | undefined;
  readonly latestLedger: number;
  /** Watermark after the pass. Unchanged when `range` is undefined. */
  readonly lastLedger: number | undefined;
}

async function runJob(
  db: SqlAdapter,
  client: HorizonClient,
  job: IngestJob,
  range: LedgerRange,
): Promise<void> {
  if (job === 'payments') {
    await ingestPayments(db, client, range);
  } else if (job === 'trustlines') {
    await ingestTrustlines(db, client, range);
  } else {
    await ingestTrades(db, client, range);
  }
}

/**
 * Run one delta pass for one job and advance its watermark.
 *
 * The watermark is written only after the ingestion call returns. An ingestion
 * that throws part-way therefore leaves the watermark where it was, and the next
 * pass re-reads the whole range — which is safe rather than merely tolerable,
 * because every insert is ON CONFLICT DO NOTHING (issue #6).
 */
export async function ingestIncrementalPass(
  db: SqlAdapter,
  client: HorizonClient,
  job: IngestJob,
  options: IncrementalOptions = {},
): Promise<IncrementalPassResult> {
  const latestLedger = await client.latestLedger();
  const lastLedger = await lastIngestedLedger(db, job);
  const range = nextRange(lastLedger, latestLedger, options);

  if (!range) {
    return { job, range: undefined, latestLedger, lastLedger };
  }

  await runJob(db, client, job, range);
  await recordIngestedLedger(db, job, range.toLedger);

  return { job, range, latestLedger, lastLedger: await lastIngestedLedger(db, job) };
}

export interface PollOptions extends IncrementalOptions {
  readonly jobs: readonly IngestJob[];
  /** Seconds between ticks. */
  readonly intervalSeconds: number;
  /** Stop after this many ticks. Omit to run until aborted. */
  readonly maxTicks?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onPass?: ((result: IncrementalPassResult) => void) | undefined;
  /** Injected for tests, so a poll loop need not really wait. */
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll for new ledgers on an interval, advancing each job independently.
 *
 * One tick runs one pass per job in the order given. A job that throws does not
 * abort the rest of that tick — its siblings still get their turn and still
 * commit their own watermarks, which is the reason watermarks are per job. The
 * first error is then rethrown once the tick finishes, so the loop stops and the
 * operator sees the failure rather than it being swallowed on a timer.
 *
 * A failure is therefore fatal to the loop but not to the tick. Restart policy
 * is deliberately left to whatever supervises the process (systemd, a container
 * runtime, a scheduled workflow) rather than being reinvented here.
 */
export async function poll(
  db: SqlAdapter,
  client: HorizonClient,
  options: PollOptions,
): Promise<IncrementalPassResult[]> {
  const sleep = options.sleep ?? defaultSleep;
  const results: IncrementalPassResult[] = [];
  let ticks = 0;

  for (;;) {
    if (options.signal?.aborted) break;

    const failures: Error[] = [];

    for (const job of options.jobs) {
      if (options.signal?.aborted) break;
      try {
        const result = await ingestIncrementalPass(db, client, job, options);
        results.push(result);
        options.onPass?.(result);
      } catch (err) {
        // Collected rather than rethrown immediately: the remaining jobs still
        // get their turn this tick.
        failures.push(err as Error);
      }
    }

    const firstFailure = failures[0];
    if (firstFailure !== undefined) {
      throw firstFailure;
    }

    ticks += 1;
    if (options.maxTicks !== undefined && ticks >= options.maxTicks) break;
    if (options.signal?.aborted) break;

    await sleep(options.intervalSeconds * 1000, options.signal);
  }

  return results;
}
