import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from './client.ts';
import { render, SQLITE, type Dialect } from './dialect.ts';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
}

const FILENAME_PATTERN = /^(\d+)_([A-Za-z0-9_-]+)\.sql$/;

function checksumOf(sql: string): string {
  // Normalise line endings before hashing. .gitattributes checks these files out
  // with LF, but a checksum that changes with the checkout would make every
  // already-applied migration look tampered with on a different platform.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Read and validate the migration set from disk, ordered by version.
 *
 * `sql` and `checksum` are for the *rendered* SQL — the dialect tokens in the
 * file expanded for `dialect` — not for the raw file text. That is deliberate:
 * the checksum records what was actually applied to a given database, and the
 * two dialects genuinely apply different DDL from the same file. It also means
 * the SQLite checksums are unchanged by the introduction of the shim, so an
 * existing SQLite database does not see every applied migration as tampered
 * with. `test/dialect.test.ts` pins those seven hashes.
 */
export function loadMigrations(
  dir: string = MIGRATIONS_DIR,
  dialect: Dialect = SQLITE,
): Migration[] {
  const migrations: Migration[] = [];
  const seen = new Map<number, string>();

  for (const filename of readdirSync(dir).sort()) {
    if (!filename.endsWith('.sql')) continue;

    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new Error(`Migration filename "${filename}" must look like 001_description.sql`);
    }

    const version = Number(match[1]);
    const name = match[2] as string;

    const duplicate = seen.get(version);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate migration version ${version}: "${duplicate}" and "${filename}". ` +
          'Two migrations sharing a version would apply in filesystem order, which ' +
          'differs between machines.',
      );
    }
    seen.set(version, filename);

    const sql = render(readFileSync(join(dir, filename), 'utf8'), dialect);
    migrations.push({ version, name, sql, checksum: checksumOf(sql) });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * Refuse to run if an applied migration's content has changed.
 *
 * Shared by both engine runners so the rule cannot drift between them: a
 * migration whose content changed after being applied means the database and
 * the repo disagree about what the schema is. Refusing here is the whole point
 * of storing the checksum — the alternative is a silent drift that only
 * surfaces as a confusing failure much later, or as a Phase 2 parity mismatch.
 */
export function assertNoChecksumDrift(
  onDisk: readonly Migration[],
  applied: ReadonlyMap<number, AppliedMigration>,
): void {
  for (const migration of onDisk) {
    const record = applied.get(migration.version);
    if (record && record.checksum !== migration.checksum) {
      throw new Error(
        `Migration ${migration.version}_${migration.name}.sql has changed since it was ` +
          `applied (recorded ${record.checksum.slice(0, 12)}, on disk ` +
          `${migration.checksum.slice(0, 12)}). Add a new migration instead of editing ` +
          'an applied one.',
      );
    }
  }
}

function ensureTrackingTable(db: Db): void {
  db.exec(SQLITE.schemaMigrationsDdl());
}

/**
 * Normalise raw `schema_migrations` rows into `AppliedMigration`.
 *
 * Exists because the two drivers hand back different JavaScript types for the
 * same logical row: `applied_at` is TEXT in SQLite and arrives as a string, but
 * is TIMESTAMPTZ in Postgres and arrives as a `Date`. Both are normalised to an
 * ISO8601 string so callers -- and the parity checks in issue #53 -- compare
 * like with like rather than a string against a Date.
 */
export function appliedMigrationsFrom(rows: readonly unknown[]): AppliedMigration[] {
  return rows.map((row) => {
    const r = row as { version: number; name: string; checksum: string; applied_at: unknown };
    return {
      version: Number(r.version),
      name: r.name,
      checksum: r.checksum,
      applied_at: r.applied_at instanceof Date ? r.applied_at.toISOString() : String(r.applied_at),
    };
  });
}

export function appliedMigrations(db: Db): AppliedMigration[] {
  ensureTrackingTable(db);
  return db
    .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[];
}

/**
 * Apply every migration not yet recorded in schema_migrations.
 *
 * Returns the versions applied, so a caller running this twice can see the second
 * run was a no-op rather than having to infer it.
 */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): number[] {
  ensureTrackingTable(db);

  const onDisk = loadMigrations(dir);
  const applied = new Map(appliedMigrations(db).map((m) => [m.version, m]));

  assertNoChecksumDrift(onDisk, applied);

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  const pending = onDisk.filter((m) => !applied.has(m.version));
  const appliedNow: number[] = [];

  for (const migration of pending) {
    // One transaction per migration: SQLite makes DDL transactional, so a failing
    // migration rolls back its own statements and leaves schema_migrations without
    // a row for it. Earlier migrations in the same run stay applied, which is what
    // makes a re-run after a fix pick up where it stopped.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    });
    run();
    appliedNow.push(migration.version);
  }

  return appliedNow;
}
