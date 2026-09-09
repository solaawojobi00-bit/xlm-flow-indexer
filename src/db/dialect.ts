/**
 * SQL dialect shim for the shared migration files (issue #48).
 *
 * The migration files in `migrations/` are the single source of truth for both
 * engines. Where the two dialects genuinely differ, the file carries a `${...}`
 * token that this module expands, so there is one numbered file per migration
 * rather than a SQLite copy and a Postgres copy drifting apart.
 *
 * Only four tokens exist, because only four things actually differ. Everything
 * else in the schema — `TEXT` account ids, `INTEGER` ledger sequences, the
 * `||` concatenation in `trade_pair_activity`, `UNION ALL`, `WITH`, window-free
 * aggregation — is portable SQL and is written plainly.
 *
 * Tokens are expanded, not interpreted: this is textual substitution over
 * repository-controlled files, not a SQL parser and not a place to put user
 * input. `render` throws on an unrecognised token rather than passing it
 * through, so a typo fails at load time instead of reaching the database as
 * invalid SQL.
 */

export type DialectName = 'sqlite' | 'postgres';

export interface Dialect {
  readonly name: DialectName;

  /**
   * Column type for a Stellar amount.
   *
   * SQLite stores the exact decimal string Horizon returned. Postgres uses
   * NUMERIC(19, 7): a Stellar amount is an int64 count of stroops at 1e-7, so
   * the largest representable value is 922337203685.4775807 — twelve integer
   * digits and seven fractional, nineteen significant digits in total. That is
   * the precision the protocol can produce, so it is the precision the column
   * declares.
   */
  readonly amountType: string;

  /**
   * Column type for a timestamp.
   *
   * SQLite stores ISO8601 UTC text. Postgres uses TIMESTAMPTZ, which is the
   * point of the translation: comparisons and `::date` bucketing become the
   * engine's job rather than relying on ISO8601 sorting lexicographically.
   */
  readonly timestampType: string;

  /** Truncate a timestamp expression to a day, for the `day` grain. */
  day(expr: string): string;

  /**
   * Read an amount column as a number for aggregation.
   *
   * SQLite has to cast, because the column is TEXT. Postgres does not, because
   * the column is already NUMERIC — and casting there would be actively
   * harmful, since it would round-trip an exact decimal through a float.
   */
  amountValue(expr: string): string;

  /** DDL for the migration tracking table, which is created in code. */
  schemaMigrationsDdl(): string;
}

export const SQLITE: Dialect = {
  name: 'sqlite',
  amountType: 'TEXT',
  timestampType: 'TEXT',
  day: (expr) => `date(${expr})`,
  amountValue: (expr) => `CAST(${expr} AS REAL)`,
  schemaMigrationsDdl: () => `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    )
  `,
};

export const POSTGRES: Dialect = {
  name: 'postgres',
  amountType: 'NUMERIC(19, 7)',
  timestampType: 'TIMESTAMPTZ',
  // `(expr)::date` rather than ARCHITECTURE.md's original suggestion of
  // `date_trunc('day', expr)`. Both bucket correctly, but date_trunc returns a
  // TIMESTAMPTZ still carrying a zero time-of-day, whereas the grain of these
  // views is a calendar day. `::date` says that in the type.
  day: (expr) => `(${expr})::date`,
  amountValue: (expr) => expr,
  schemaMigrationsDdl: () => `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL
    )
  `,
};

export const DIALECTS: Record<DialectName, Dialect> = {
  sqlite: SQLITE,
  postgres: POSTGRES,
};

export function dialectFor(name: string): Dialect {
  const dialect = DIALECTS[name as DialectName];
  if (!dialect) {
    throw new Error(
      `Unknown SQL dialect "${name}". Expected one of: ${Object.keys(DIALECTS).join(', ')}.`,
    );
  }
  return dialect;
}

/**
 * Tokens taking an argument, e.g. `${day(o.created_at)}`.
 *
 * The argument deliberately cannot contain parentheses. Every real use is a
 * bare column reference, and refusing nested parens keeps this a substitution
 * with an obvious bound rather than something that has to balance brackets to
 * know where the token ends.
 */
const CALL_TOKEN = /\$\{(day|amount)\(([^()]*)\)\}/g;

/** Bare tokens, e.g. `${amountType}`. */
const BARE_TOKEN = /\$\{([A-Za-z]+)\}/g;

/** Anything still token-shaped after expansion, so typos cannot pass through. */
const LEFTOVER_TOKEN = /\$\{[^}]*\}/;

/**
 * Expand the dialect tokens in a migration file.
 *
 * For SQLite the output is byte-identical to the pre-shim migration files. That
 * is a hard requirement rather than a nicety: migration checksums are taken over
 * this rendered SQL, so any drift in the SQLite output would make every
 * already-applied migration look tampered with and refuse to run against an
 * existing database. `test/dialect.test.ts` pins the resulting checksums.
 */
export function render(sql: string, dialect: Dialect): string {
  const expanded = sql
    .replace(CALL_TOKEN, (_match, fn: string, arg: string) => {
      const trimmed = arg.trim();
      if (trimmed === '') {
        throw new Error(`Dialect token \${${fn}(...)} was given an empty argument.`);
      }
      return fn === 'day' ? dialect.day(trimmed) : dialect.amountValue(trimmed);
    })
    .replace(BARE_TOKEN, (match, name: string) => {
      if (name === 'amountType') return dialect.amountType;
      if (name === 'timestampType') return dialect.timestampType;
      throw new Error(
        `Unknown dialect token "${match}". Known tokens: \${amountType}, ` +
          '${timestampType}, ${day(expr)}, ${amount(expr)}.',
      );
    });

  const leftover = LEFTOVER_TOKEN.exec(expanded);
  if (leftover) {
    throw new Error(
      `Unexpanded dialect token "${leftover[0]}" after rendering for ${dialect.name}. ` +
        'A token with an argument must look like ${day(column)} with no nested parentheses.',
    );
  }

  return expanded;
}
