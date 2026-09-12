/**
 * Engine-neutral data access for the ingestion jobs (issue #67).
 *
 * The schema has been dual-dialect since #48, but the jobs were not: they drove
 * a `better-sqlite3` handle directly, synchronously, so `ingest` and `poll` were
 * SQLite-only. This is the seam that decouples them — one interface the jobs
 * write against, with one adapter per engine behind it, so there is one copy of
 * the job logic rather than one per engine.
 *
 * ---------------------------------------------------------------------------
 * Why connection-level rather than statement-level
 * ---------------------------------------------------------------------------
 * The obvious translation of the old code would be a `prepare(sql)` returning a
 * statement handle with `run`/`get`/`all` on it, mirroring better-sqlite3. That
 * was rejected: `pg` has no equivalent object with a comparable lifecycle, so the
 * interface would be modelling a concept only one engine has, and every adapter
 * would owe an answer to when a handle is released.
 *
 * The only thing that shape bought was better-sqlite3's prepare-once-reuse-often
 * idiom, and that is recovered inside the SQLite adapter by caching compiled
 * statements by SQL text. The jobs lose the ceremony, not the compilation.
 *
 * ---------------------------------------------------------------------------
 * What this is not
 * ---------------------------------------------------------------------------
 * Not a query builder and not a SQL translator. Job SQL is hand-written and
 * already portable: bare `ON CONFLICT DO NOTHING`, and the watermark upsert's
 * `DO UPDATE ... WHERE` predicate, are read identically by both engines. The one
 * genuine text difference is placeholder syntax, and absorbing it is the
 * relevant adapter's business, not this module's.
 *
 * It is also unrelated to ./dialect.ts, despite both existing because the
 * engines differ. `dialect.ts` is compile-time `${token}` substitution over
 * repository-owned migration files; this is runtime execution of hand-written
 * job SQL. They share no code and neither calls the other.
 */

import type { DialectName } from './dialect.ts';

/**
 * A value bindable to a placeholder.
 *
 * `boolean` is included even though SQLite cannot bind one — better-sqlite3
 * accepts only numbers, bigints, strings, buffers and null. The SQLite adapter
 * converts it, which is exactly the kind of difference this seam exists to
 * absorb; a caller should not have to know which engine it is talking to in
 * order to pass a flag. No current job binds one.
 */
export type SqlParam = string | number | bigint | boolean | null;

export interface RunResult {
  /**
   * Rows actually inserted, updated or deleted.
   *
   * `changes` in better-sqlite3, `rowCount` in pg — normalised here because
   * every `IngestResult` counter is built from it. Under the jobs'
   * `ON CONFLICT DO NOTHING` inserts this is 0 for a row already present, which
   * is what makes the "written" counts mean written rather than seen.
   */
  readonly rowsAffected: number;
}

export interface SqlAdapter {
  /**
   * Which engine is behind this adapter.
   *
   * Present so a job *could* branch, not because one does. No job SQL needs a
   * dialect token today and that is worth keeping true: a use of this field in
   * `src/ingest/` is a signal that a statement stopped being portable.
   */
  readonly dialect: DialectName;

  /** Execute a write. Placeholders are `?`, in every dialect. */
  run(sql: string, params?: readonly SqlParam[]): Promise<RunResult>;

  /** First row, or `undefined` when the query matched nothing. */
  get<T>(sql: string, params?: readonly SqlParam[]): Promise<T | undefined>;

  /** All matching rows, `[]` when none matched. */
  all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;

  /**
   * Run `fn` in a transaction, committing on return and rolling back on throw.
   *
   * `tx` is guaranteed to be the same connection, which is what makes this mean
   * anything once a pooled adapter exists: work sent to a sibling connection
   * would commit independently of this transaction. Nesting is not supported and
   * throws rather than silently flattening into the outer transaction, where a
   * failed inner block would appear to have rolled back but had not.
   */
  transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T>;

  /** Release the underlying connection. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Normalise a driver's idea of a timestamp to an ISO8601 string.
 *
 * The two drivers hand back different JavaScript types for the same logical
 * column: a TEXT timestamp arrives from SQLite as a string, while the same
 * column as TIMESTAMPTZ arrives from pg as a `Date`. Callers that compare or
 * print these need one type, not two.
 *
 * Shared by `appliedMigrationsFrom` in ./migrate.ts and `allIngestState` in
 * ../ingest/state.ts. It lives here rather than in either of them because the
 * difference belongs to the driver boundary, and because two copies of this
 * would be two places to fix when a third timestamp column appears.
 */
export function isoStringOf(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
