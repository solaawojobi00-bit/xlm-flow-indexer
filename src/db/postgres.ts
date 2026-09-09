import { POSTGRES } from './dialect.ts';
import {
  appliedMigrationsFrom,
  assertNoChecksumDrift,
  loadMigrations,
  MIGRATIONS_DIR,
  type AppliedMigration,
} from './migrate.ts';

/**
 * The slice of a Postgres client this runner needs (issue #48).
 *
 * Deliberately structural rather than importing `pg`'s `Client` type. The
 * migration runner needs exactly one capability — send SQL, get rows back —
 * and depending on the concrete driver type here would mean this module could
 * not be tested without a live connection. `node-postgres` satisfies this
 * interface as-is, and so does a fake.
 */
export interface PgQueryable {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * Apply every migration not yet recorded in `schema_migrations`.
 *
 * The Postgres counterpart to `migrate` in ./migrate.ts, and deliberately the
 * same shape: same tracking table, same checksum rule, same
 * one-transaction-per-migration behaviour, returning the versions applied so a
 * caller running it twice can see the second run was a no-op.
 *
 * The migrations are the same files. Only the dialect tokens expand differently
 * — amounts to NUMERIC(19, 7), timestamps to TIMESTAMPTZ, day bucketing to
 * `::date`. See ./dialect.ts.
 */
export async function migratePostgres(
  client: PgQueryable,
  dir: string = MIGRATIONS_DIR,
): Promise<number[]> {
  await client.query(POSTGRES.schemaMigrationsDdl());

  const onDisk = loadMigrations(dir, POSTGRES);
  const applied = new Map(
    (await appliedPostgresMigrations(client)).map((m) => [m.version, m] as const),
  );

  assertNoChecksumDrift(onDisk, applied);

  const appliedNow: number[] = [];

  for (const migration of onDisk.filter((m) => !applied.has(m.version))) {
    // One transaction per migration, matching the SQLite runner. Postgres makes
    // DDL transactional too, so a failing migration rolls back its own
    // statements and leaves schema_migrations without a row for it -- earlier
    // migrations in the same run stay applied, which is what makes a re-run
    // after a fix pick up where it stopped.
    //
    // ROLLBACK is issued on failure rather than left to the connection, because
    // a pooled client handed back mid-transaction would poison the next caller.
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
        [migration.version, migration.name, migration.checksum, new Date().toISOString()],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    appliedNow.push(migration.version);
  }

  return appliedNow;
}

export async function appliedPostgresMigrations(client: PgQueryable): Promise<AppliedMigration[]> {
  await client.query(POSTGRES.schemaMigrationsDdl());
  const { rows } = await client.query(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return appliedMigrationsFrom(rows);
}
