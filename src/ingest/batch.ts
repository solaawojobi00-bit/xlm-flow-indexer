/**
 * Bounded write batching for the ingestion jobs (issue #68).
 *
 * Every insert used to autocommit on its own. Against SQLite that is merely
 * wasteful; against Postgres each commit is a durability barrier the server has
 * to flush before it answers, so a pass that writes a few thousand rows pays a
 * few thousand of them.
 *
 * ---------------------------------------------------------------------------
 * Why not one transaction per pass
 * ---------------------------------------------------------------------------
 * Because `DEFAULT_MAX_LEDGERS_PER_PASS` in ./incremental.ts exists to stop a
 * long catch-up from "holding a transaction open for minutes", and a whole-pass
 * transaction reintroduces exactly that — a pass is capped at 200 *ledgers*,
 * which is an unbounded number of *records*. The bound has to be on the writes
 * themselves, which is what this is.
 *
 * ---------------------------------------------------------------------------
 * What a failure now means
 * ---------------------------------------------------------------------------
 * Unchanged in the way that matters, coarser in the way that does not:
 *
 * - Before: a failure mid-pass left every row written so far committed.
 * - Now: it leaves every *completed batch* committed and rolls back the one in
 *   flight.
 *
 * In both cases the watermark is untouched, because ./incremental.ts advances it
 * only after the ingestion call returns. The next pass therefore re-reads the
 * whole range, writes nothing for the rows that survived, and rewrites the
 * batch that was rolled back. That is issue #6's idempotency doing the work, not
 * a new guarantee — every insert is `ON CONFLICT DO NOTHING`.
 *
 * The one thing that genuinely changes is what a concurrent reader sees: rows
 * now appear a batch at a time rather than one at a time. No reader in this
 * project depends on mid-pass granularity, and the analytical views are
 * aggregates over committed rows either way.
 */

/**
 * Records per transaction.
 *
 * 200 matches the `limit` the jobs pass to Horizon, so a batch is about one
 * page's worth of records and a pass commits roughly once per page fetched.
 * That is a deliberate coincidence rather than a derivation — the two are
 * separate knobs, and nothing breaks if one changes without the other, because
 * this counts records as they arrive and has no idea where a page ended.
 *
 * Bounding *records* rather than statements is the honest description: one
 * record writes between one and five rows depending on the job, so a batch is at
 * most a few hundred statements. That is the property worth having — a ceiling
 * that does not grow with the size of the pass.
 */
export const DEFAULT_BATCH_RECORDS = 200;

export interface BatchOptions {
  /**
   * Records per transaction. Defaults to `DEFAULT_BATCH_RECORDS`.
   *
   * Exposed mainly so tests can force several batches out of a small fixture
   * without having to record a large one.
   */
  readonly batchSize?: number | undefined;
}

export function batchSizeOf(options: BatchOptions | undefined): number {
  const size = options?.batchSize ?? DEFAULT_BATCH_RECORDS;
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`batchSize must be a positive integer, got ${String(size)}`);
  }
  return size;
}

/**
 * Group records into batches, stopping at the first one outside the range.
 *
 * The two responsibilities are together because the jobs need them together: the
 * `break` that used to end each job's loop has to stop the *source* as well, so
 * that Horizon is not asked for another page past the end of the range. Chunking
 * first and filtering afterwards would fetch that page.
 *
 * `withinRange` is a predicate on the record rather than a ledger bound because
 * each job reads the ledger sequence from a different place — `sequence` on a
 * ledger, `paging_token` on everything else.
 */
export async function* batchesWithin<T>(
  source: AsyncIterable<T>,
  withinRange: (record: T) => boolean,
  size: number,
): AsyncGenerator<T[], void, undefined> {
  let batch: T[] = [];

  for await (const record of source) {
    if (!withinRange(record)) break;

    batch.push(record);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }

  // The final partial batch. Skipped when empty, so a job with nothing to do
  // opens no transaction at all.
  if (batch.length > 0) yield batch;
}
