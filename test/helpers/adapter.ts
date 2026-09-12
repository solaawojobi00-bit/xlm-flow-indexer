import type { SqlAdapter } from '../../src/db/adapter.ts';
import type { Db } from '../../src/db/client.ts';
import { sqliteAdapter } from '../../src/db/sqlite-adapter.ts';

/**
 * The `SqlAdapter` for a test's raw SQLite handle (issue #67).
 *
 * The suites open a handle with `openDb` and assert against it directly —
 * `db.prepare('SELECT COUNT(*) ...')` and friends, roughly 150 times across the
 * project. The jobs, since #67, take the engine-neutral seam instead. Rather
 * than rewrite every assertion, each suite keeps its handle and wraps it here at
 * the point it calls a job.
 *
 * Memoised per handle so a suite gets one adapter with one statement cache,
 * matching how the CLI uses it: a fresh adapter per call would still be correct,
 * but it would exercise a shape production never has.
 */
const adapters = new WeakMap<Db, SqlAdapter>();

export function adapt(db: Db): SqlAdapter {
  const existing = adapters.get(db);
  if (existing) return existing;

  const created = sqliteAdapter(db);
  adapters.set(db, created);
  return created;
}
