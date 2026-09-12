import type Database from 'better-sqlite3';

import type { RunResult, SqlAdapter, SqlParam } from './adapter.ts';
import type { Db } from './client.ts';
import { SQLITE } from './dialect.ts';

/**
 * `SqlAdapter` over a better-sqlite3 handle (issue #67).
 *
 * Wraps rather than replaces `openDb`. That is deliberate: the handle stays the
 * public thing, because the test suites assert against it directly — roughly 150
 * `.prepare()` calls across fourteen files read rows back to check what a job
 * wrote — and routing those through an async adapter would have turned a
 * mechanical refactor into a rewrite of every assertion in the project.
 *
 * Every method is `async` despite better-sqlite3 being entirely synchronous.
 * The promises resolve immediately and no work is deferred; the signatures exist
 * so job code can be written once against an interface that a genuinely async
 * driver can also implement.
 */

/**
 * Compiled-statement cache, keyed by SQL text.
 *
 * The jobs used to hoist `db.prepare(...)` above their loops and reuse the
 * statement per row, which is better-sqlite3's documented way to avoid
 * recompiling. The connection-level seam has no statement object to hoist, so
 * that idiom would have been lost at the call sites and paid for on every row.
 * Caching here restores it without the jobs having to care: the same SQL string
 * compiles once per connection however many times it is executed.
 *
 * Unbounded because the key space is not user-controlled — it is the fixed set
 * of SQL literals in `src/ingest/` and `src/db/`, a dozen or so strings.
 */
type StatementCache = Map<string, Database.Statement>;

/**
 * Adapt parameters to what better-sqlite3 will bind.
 *
 * It accepts numbers, bigints, strings, buffers and null, and throws on a
 * boolean — whereas pg binds one natively. Converting to SQLite's usual 1/0
 * encoding here keeps `SqlParam` honest, so a caller need not know which engine
 * is behind the adapter to pass a flag.
 */
function bindable(params: readonly SqlParam[]): unknown[] {
  return params.map((param) => (typeof param === 'boolean' ? (param ? 1 : 0) : param));
}

export interface SqliteAdapterOptions {
  /**
   * Close the underlying handle when `close()` is called.
   *
   * Off by default, because the adapter borrows a handle it did not open and
   * the opener is normally still using it — the CLI closes its own handle in a
   * `finally`, and the tests keep theirs for assertions. Callers that hand the
   * adapter sole ownership opt in.
   */
  readonly closeHandle?: boolean;
}

/**
 * Wrap an open SQLite handle in the engine-neutral seam.
 *
 * A factory over an object literal rather than a class: the methods close over
 * the handle and the cache instead of depending on `this`, so a destructured
 * `const { run } = adapter` keeps working, and `erasableSyntaxOnly` in
 * tsconfig.json rules out the parameter-property form that would have made a
 * class worth the ceremony.
 */
export function sqliteAdapter(db: Db, options: SqliteAdapterOptions = {}): SqlAdapter {
  const cache: StatementCache = new Map();
  let depth = 0;

  function compile(sql: string): Database.Statement {
    const cached = cache.get(sql);
    if (cached) return cached;

    const statement = db.prepare(sql);
    cache.set(sql, statement);
    return statement;
  }

  const adapter: SqlAdapter = {
    dialect: SQLITE.name,

    run(sql: string, params: readonly SqlParam[] = []): Promise<RunResult> {
      const { changes } = compile(sql).run(...bindable(params));
      return Promise.resolve({ rowsAffected: changes });
    },

    get<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | undefined> {
      return Promise.resolve(compile(sql).get(...bindable(params)) as T | undefined);
    },

    all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
      return Promise.resolve(compile(sql).all(...bindable(params)) as T[]);
    },

    /**
     * BEGIN/COMMIT/ROLLBACK issued by hand, rather than via `db.transaction()`.
     *
     * better-sqlite3's own helper takes a *synchronous* function and runs it to
     * completion inside the transaction. An `async` callback handed to it
     * returns a pending promise immediately, so the transaction would commit
     * before any awaited statement inside it had run — a silent correctness bug,
     * not a type error. The seam's callback is async by definition, so the
     * helper cannot be used and the control statements are issued directly.
     */
    async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
      if (depth > 0) {
        throw new Error(
          'Nested SqlAdapter.transaction() is not supported. SQLite has no nested ' +
            'transactions, so the inner block would commit or roll back the outer one.',
        );
      }

      db.exec('BEGIN');
      depth += 1;

      try {
        const result = await fn(adapter);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        // Guarded: a failed COMMIT can leave no transaction open, and a ROLLBACK
        // that then throws would replace the real error with a confusing one
        // about there being nothing to roll back.
        try {
          db.exec('ROLLBACK');
        } catch {
          /* the original error is the one worth propagating */
        }
        throw err;
      } finally {
        depth -= 1;
      }
    },

    close(): Promise<void> {
      cache.clear();
      if (options.closeHandle && db.open) db.close();
      return Promise.resolve();
    },
  };

  return adapter;
}
