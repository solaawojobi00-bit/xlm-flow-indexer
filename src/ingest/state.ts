import type { Db } from '../db/client.ts';

/**
 * Ingestion jobs that carry their own watermark.
 *
 * Mirrors the CHECK constraint on `ingest_state.job`. Kept as a const array so
 * the type and the runtime list cannot drift.
 */
export const INGEST_JOBS = ['payments', 'trustlines', 'trades'] as const;

export type IngestJob = (typeof INGEST_JOBS)[number];

export interface IngestState {
  readonly job: IngestJob;
  /** Last fully processed ledger sequence. */
  readonly last_ledger: number;
  readonly updated_at: string;
}

export function isIngestJob(value: string): value is IngestJob {
  return (INGEST_JOBS as readonly string[]).includes(value);
}

/**
 * The last fully processed ledger for a job, or undefined if it has never run.
 *
 * `undefined` and `0` are deliberately different answers. A job that has never
 * run has no opinion about where to start and the caller must supply one; a job
 * recorded at 0 has been initialised and should resume at ledger 1.
 */
export function lastIngestedLedger(db: Db, job: IngestJob): number | undefined {
  const row = db.prepare('SELECT last_ledger FROM ingest_state WHERE job = ?').get(job) as
    { last_ledger: number } | undefined;
  return row ? Number(row.last_ledger) : undefined;
}

export function allIngestState(db: Db): IngestState[] {
  return db
    .prepare('SELECT job, last_ledger, updated_at FROM ingest_state ORDER BY job')
    .all() as IngestState[];
}

/**
 * Advance a job's watermark.
 *
 * Monotonic by construction: the stored value only ever moves forward, because
 * `MAX(excluded, existing)` is applied in SQL rather than trusting the caller.
 * Two overlapping passes, or a re-run of an older range, therefore cannot rewind
 * progress and cause the same ledgers to be re-read forever.
 *
 * There is deliberately no rewind counterpart. Filling a gap does not need one:
 * the documented backfill procedure runs the ordinary `ingest` command over the
 * missing range, which writes the rows directly through the same statements,
 * leaving the watermark alone. Adding a rewind would mean a second way to reach
 * the same state, with the added risk of re-polling ground already covered.
 */
export function recordIngestedLedger(db: Db, job: IngestJob, ledger: number): void {
  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new RangeError(`Ledger watermark must be a non-negative integer, got ${String(ledger)}`);
  }

  db.prepare(
    `INSERT INTO ingest_state (job, last_ledger, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (job) DO UPDATE SET
       last_ledger = MAX(excluded.last_ledger, ingest_state.last_ledger),
       updated_at  = excluded.updated_at`,
  ).run(job, ledger, new Date().toISOString());
}
