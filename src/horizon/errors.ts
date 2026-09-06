/** Base class for every error this client raises, so callers can catch one type. */
export class HorizonError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HorizonError';
  }
}

/**
 * Horizon returned a response we will not retry.
 *
 * Carries the status and a truncated body: Horizon's problem+json payloads name the
 * failing field, and losing that turns a diagnosable 400 into a mystery.
 */
export class HorizonHttpError extends HorizonError {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`Horizon responded ${String(status)} for ${url}${body ? `: ${body}` : ''}`);
    this.name = 'HorizonHttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** Every retry was used and the request still failed. */
export class HorizonRetryLimitError extends HorizonError {
  readonly attempts: number;
  readonly url: string;

  constructor(attempts: number, url: string, options?: ErrorOptions) {
    super(`Horizon request to ${url} failed after ${String(attempts)} attempt(s)`, options);
    this.name = 'HorizonRetryLimitError';
    this.attempts = attempts;
    this.url = url;
  }
}

/**
 * The overall deadline elapsed.
 *
 * Distinct from the retry limit: a wedged Horizon that keeps returning 503 quickly
 * exhausts retries, whereas one that accepts connections and never responds would
 * otherwise hang until the job is killed. CI needs the second case to fail on its own.
 */
export class HorizonTimeoutError extends HorizonError {
  readonly url: string;
  readonly elapsedMs: number;

  constructor(url: string, elapsedMs: number, options?: ErrorOptions) {
    super(`Horizon request to ${url} exceeded the deadline after ${String(elapsedMs)}ms`, options);
    this.name = 'HorizonTimeoutError';
    this.url = url;
    this.elapsedMs = elapsedMs;
  }
}
