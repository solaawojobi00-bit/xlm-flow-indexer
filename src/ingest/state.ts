import { isoStringOf, type SqlAdapter } from '../db/adapter.ts';

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
export async function lastIngestedLedger(
  db: SqlAdapter,
  job: IngestJob,
): Promise<number | undefined> {
  const row = await db.get<{ last_ledger: number }>(
    'SELECT last_ledger FROM ingest_state WHERE job = ?',
    [job],
  );
  return row ? Number(row.last_ledger) : undefined;
}

/**
 * Every job's watermark, ordered by job.
 *
 * The columns are normalised rather than returned as the driver produced them.
 * `updated_at` is the reason: it is TEXT in SQLite and TIMESTAMPTZ in Postgres,
 * so the same column arrives as a string from one driver and a `Date` from the
 * other, and `IngestState` promises a string. `isoStringOf` is the same
 * normalisation `appliedMigrationsFrom` applies to `schema_migrations` -- shared
 * rather than reimplemented, because a second copy is a second thing to fix.
 *
 * `last_ledger` gets the same treatment `lastIngestedLedger` already applied, so
 * the two functions cannot disagree about the type of the same column.
 */
export async function allIngestState(db: SqlAdapter): Promise<IngestState[]> {
  const rows = await db.all<{ job: IngestJob; last_ledger: number; updated_at: unknown }>(
    'SELECT job, last_ledger, updated_at FROM ingest_state ORDER BY job',
  );

  return rows.map((row) => ({
    job: row.job,
    last_ledger: Number(row.last_ledger),
    updated_at: isoStringOf(row.updated_at),
  }));
}

/**
 * Advance a job's watermark.
 *
 * Monotonic by construction: the stored value only ever moves forward, because
 * the guard lives in SQL rather than being trusted to the caller. Two
 * overlapping passes, or a re-run of an older range, therefore cannot rewind
 * progress and cause the same ledgers to be re-read forever.
 *
 * The monotonicity is expressed as a `DO UPDATE ... WHERE` predicate rather than
 * as `last_ledger = MAX(excluded.last_ledger, ingest_state.last_ledger)`, which
 * is the obvious form and is SQLite-only: SQLite's `max()` is a variadic scalar
 * function, while in Postgres `MAX` is strictly an aggregate and a two-argument
 * call is a syntax error. `GREATEST` would be the Postgres spelling and does not
 * exist in SQLite, so either scalar form would need a dialect token. The WHERE
 * predicate is understood identically by both engines and needs no shim: when
 * the incoming value is not greater the update is simply skipped, leaving the
 * row -- and its `updated_at` -- untouched.
 *
 * There is deliberately no rewind counterpart. Filling a gap does not need one:
 * the documented backfill procedure runs the ordinary `ingest` command over the
 * missing range, which writes the rows directly through the same statements,
 * leaving the watermark alone. Adding a rewind would mean a second way to reach
 * the same state, with the added risk of re-polling ground already covered.
 */
export async function recordIngestedLedger(
  db: SqlAdapter,
  job: IngestJob,
  ledger: number,
): Promise<void> {
  if (!Number.isInteger(ledger) || ledger < 0) {
    throw new RangeError(`Ledger watermark must be a non-negative integer, got ${String(ledger)}`);
  }

  await db.run(
    `INSERT INTO ingest_state (job, last_ledger, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (job) DO UPDATE SET
       last_ledger = excluded.last_ledger,
       updated_at  = excluded.updated_at
     WHERE excluded.last_ledger > ingest_state.last_ledger`,
    [job, ledger, new Date().toISOString()],
  );
}
