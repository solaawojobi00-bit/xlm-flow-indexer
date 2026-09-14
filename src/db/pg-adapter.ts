import type { RunResult, SqlAdapter, SqlParam } from './adapter.ts';
import { POSTGRES } from './dialect.ts';

/**
 * `SqlAdapter` over a node-postgres connection (issue #72).
 *
 * The second implementation of the seam #67 introduced, and the one that makes
 * the seam mean anything: with a single adapter behind it the jobs were portable
 * in principle only. Nothing in `src/ingest/` changes to gain this — that is the
 * point of the exercise.
 *
 * Mirrors ../db/sqlite-adapter.ts deliberately, down to the nesting guard and the
 * borrowed-connection default, so the two adapters can be read side by side and
 * held to one contract by one test table.
 */

/**
 * The slice of a pg client this adapter drives.
 *
 * Structural rather than an import of pg's `Client`, matching `PgQueryable` in
 * ./postgres.ts and for the same reason: depending on the concrete driver type
 * would mean this module could not be exercised without a live server. pg's
 * `Client` satisfies it as-is, and so does a fake.
 *
 * It must be a *single connection*, not a `Pool`. A pool hands out an arbitrary
 * connection per `query`, so `BEGIN` would open a transaction on one and the
 * statements meant to be inside it would run on others and autocommit —
 * `transaction()` would silently guarantee nothing. Callers holding a pool
 * should check a client out and pass that.
 */
export interface PgConnection {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
}

/**
 * A dollar-quote opener: `$$` or `$tag$`.
 *
 * The tag rule is Postgres's own — an identifier, so it cannot start with a
 * digit. That exclusion is load-bearing rather than pedantic: it is what keeps
 * `$1` from being mistaken for the start of a dollar-quoted string, which would
 * swallow the rest of the statement looking for a close that never comes.
 */
const DOLLAR_QUOTE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Characters that can continue an identifier, for the `E'...'` lookback. */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$]/;

/** A positional placeholder that was in the SQL before this function saw it. */
const EXISTING_PLACEHOLDER = /^\$\d+/;

/**
 * Is the quote at `at` opening an `E'...'` escape string?
 *
 * With `standard_conforming_strings` on — the default since 9.1 — a backslash in
 * an ordinary literal is just a backslash. In an `E'...'` literal it still
 * escapes, so `E'\''` contains a quote rather than ending. Only the `E` form
 * needs the backslash rule, and applying it unconditionally would mis-scan an
 * ordinary literal ending in a backslash.
 */
function opensEscapeString(sql: string, at: number): boolean {
  const prefix = sql[at - 1];
  if (prefix !== 'E' && prefix !== 'e') return false;

  const before = sql[at - 2];
  return before === undefined || !IDENTIFIER_CHAR.test(before);
}

/**
 * Rewrite `?` placeholders as pg's positional `$1`, `$2`, ...
 *
 * `SqlAdapter` documents its placeholder as `?` in every dialect (see
 * ./adapter.ts). That was settled in #67 — the alternative was every job knowing
 * which engine it is talking to — which makes the translation this adapter's
 * problem rather than the caller's.
 *
 * The obvious `sql.replace(/\?/g, ...)` is wrong as soon as a `?` appears
 * somewhere that is not a placeholder. No job SQL contains one today, and that
 * is exactly the kind of fact that stops being true without anyone noticing. So
 * this scans rather than substitutes, stepping over the regions where a `?` is
 * data:
 *
 * - `'string literals'`, with `''` as the escape, plus the `E'...'` backslash form
 * - `"quoted identifiers"`, with `""` as the escape
 * - `$$ dollar quoted $$` and `$tag$ ... $tag$`
 * - line comments, and block comments, which nest in Postgres
 *
 * This is a scanner over repository-owned SQL, not a parser and not a security
 * boundary. Parameters are bound by the driver and never interpolated here; the
 * only thing at stake is that a `?` which was never a placeholder reaches the
 * server unchanged.
 *
 * SQL that already carries its own `$1` is rejected rather than converted. That
 * statement was written for pg rather than for the seam, and numbering fresh
 * placeholders alongside the existing ones would collide silently — two
 * different values claiming `$1`, with only one of them bound.
 *
 * The one case it deliberately does not cover is Postgres's `?`, `?|` and `?&`
 * JSONB operators, which sit in ordinary expression position and are not
 * distinguishable from a placeholder without parsing the statement. Nothing in
 * this schema is JSONB. If that changes, the function spellings — `jsonb_exists`,
 * `jsonb_exists_any`, `jsonb_exists_all` — mean the same thing and contain no `?`.
 */
export function toPositionalPlaceholders(sql: string): string {
  let out = '';
  let placeholder = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    // -- line comment, to end of line
    if (ch === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      const stop = newline === -1 ? sql.length : newline;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ -- nesting, unlike C
    if (ch === '/' && sql[i + 1] === '*') {
      const start = i;
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          i += 1;
        }
      }
      out += sql.slice(start, i);
      continue;
    }

    // $$ ... $$ / $tag$ ... $tag$
    if (ch === '$') {
      const rest = sql.slice(i);
      const opener = DOLLAR_QUOTE.exec(rest)?.[0];
      if (opener !== undefined) {
        const close = sql.indexOf(opener, i + opener.length);
        const stop = close === -1 ? sql.length : close + opener.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }

      // A `$n` here is already a positional placeholder, so this statement was
      // written for pg rather than for the seam. Numbering our own `$n` on top
      // of it would collide silently and bind the wrong value to one of them.
      const existing = EXISTING_PLACEHOLDER.exec(rest)?.[0];
      if (existing !== undefined) {
        throw new Error(
          `SQL passed to the Postgres adapter already contains a positional placeholder ` +
            `(${existing}). SqlAdapter statements use ? in every dialect -- mixing the two ` +
            `would produce colliding parameter numbers.`,
        );
      }
    }

    // "quoted identifier"
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }

    // 'string literal'
    if (ch === "'") {
      const escapes = opensEscapeString(sql, i);
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (escapes && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }

    if (ch === '?') {
      placeholder += 1;
      out += `$${String(placeholder)}`;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export interface PgAdapterOptions {
  /**
   * End the underlying connection when `close()` is called.
   *
   * Off by default, matching `closeHandle` in ../db/sqlite-adapter.ts and for the
   * same reason: the adapter normally borrows a connection it did not open and
   * the opener is still using — the Postgres suites keep theirs to assert
   * against. Callers that hand the adapter sole ownership opt in.
   */
  readonly closeConnection?: boolean;
}

/**
 * Wrap an open Postgres connection in the engine-neutral seam.
 *
 * A factory over an object literal rather than a class, as with the SQLite
 * adapter: the methods close over the connection rather than depending on
 * `this`, so a destructured `const { run } = adapter` keeps working, and
 * `erasableSyntaxOnly` in tsconfig.json rules out the parameter-property form
 * that would make a class worth the ceremony.
 */
export function pgAdapter(client: PgConnection, options: PgAdapterOptions = {}): SqlAdapter {
  /**
   * Converted SQL, keyed by the original text.
   *
   * The counterpart to the SQLite adapter's compiled-statement cache. The work
   * saved is smaller — a scan rather than a compile — but the reason to cache is
   * the same: the jobs execute a fixed set of string literals once per row, and
   * rescanning each one per row is work with a known answer. Unbounded for the
   * same reason too: the key space is the SQL in `src/ingest/` and `src/db/`, not
   * anything a user supplies.
   */
  const converted = new Map<string, string>();
  let depth = 0;
  let ended = false;

  function positional(sql: string): string {
    const cached = converted.get(sql);
    if (cached !== undefined) return cached;

    const rewritten = toPositionalPlaceholders(sql);
    converted.set(sql, rewritten);
    return rewritten;
  }

  /**
   * Parameters reach pg as they are.
   *
   * No counterpart to the SQLite adapter's `bindable`: that converts booleans to
   * 1/0 because better-sqlite3 refuses to bind one, whereas pg binds a boolean
   * natively and would store 1/0 as the string "1" against a boolean column.
   * `bigint` is handled by the driver's own `toString`.
   */
  function query(
    sql: string,
    params: readonly SqlParam[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }> {
    return client.query(positional(sql), params);
  }

  const adapter: SqlAdapter = {
    dialect: POSTGRES.name,

    async run(sql: string, params: readonly SqlParam[] = []): Promise<RunResult> {
      const { rowCount } = await query(sql, params);
      // `rowCount` is null for statements that report no count. Left as null it
      // would reach an IngestResult counter and turn the running total into NaN,
      // which reads as a broken job rather than as "no rows".
      return { rowsAffected: rowCount ?? 0 };
    },

    async get<T>(sql: string, params: readonly SqlParam[] = []): Promise<T | undefined> {
      const { rows } = await query(sql, params);
      return rows[0] as T | undefined;
    },

    async all<T>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
      const { rows } = await query(sql, params);
      return rows as T[];
    },

    /**
     * BEGIN/COMMIT/ROLLBACK on the one connection this adapter holds.
     *
     * The same shape as the SQLite adapter's, though for a different reason:
     * there it is because better-sqlite3's `db.transaction()` helper cannot take
     * an async callback. Here there is no helper to reject — pg has only the
     * control statements — but the nesting guard matters just as much, because
     * a second `BEGIN` on a connection already in a transaction is a warning
     * Postgres shrugs off (`there is already a transaction in progress`) rather
     * than an error. The inner block's COMMIT would then commit the outer one's
     * work, and the outer block would carry on believing it could still roll
     * back. Failing loudly beats appearing to work.
     */
    async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
      if (depth > 0) {
        throw new Error(
          'Nested SqlAdapter.transaction() is not supported. Postgres ignores a second ' +
            'BEGIN with a warning, so the inner block would commit or roll back the outer one.',
        );
      }

      await client.query('BEGIN');
      depth += 1;

      try {
        const result = await fn(adapter);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        // Guarded, as in the SQLite adapter: a failed COMMIT can leave no
        // transaction open, and a ROLLBACK that then throws would replace the
        // real error with a confusing one about there being nothing to roll
        // back. Issuing it at all is not optional — a connection handed back
        // still inside a transaction poisons whoever gets it next.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the original error is the one worth propagating */
        }
        throw err;
      } finally {
        depth -= 1;
      }
    },

    async close(): Promise<void> {
      converted.clear();
      // `end()` is not itself safe to call twice on a pg Client, and the seam
      // promises that `close()` is.
      if (options.closeConnection && !ended) {
        ended = true;
        await client.end();
      }
    },
  };

  return adapter;
}
