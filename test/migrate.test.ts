import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { openDb } from '../src/db/client.ts';
import { appliedMigrations, loadMigrations, migrate } from '../src/db/migrate.ts';

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xlm-migrate-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('loadMigrations', () => {
  it('orders by numeric version, not lexically', () => {
    const dir = scratch();
    // '010' sorts before '009' only if compared numerically after parsing; a plain
    // string sort of these filenames happens to be correct, so use versions where
    // the two orders genuinely differ.
    writeFileSync(join(dir, '2_second.sql'), 'CREATE TABLE b (x);');
    writeFileSync(join(dir, '10_tenth.sql'), 'CREATE TABLE c (x);');
    writeFileSync(join(dir, '1_first.sql'), 'CREATE TABLE a (x);');

    assert.deepEqual(
      loadMigrations(dir).map((m) => m.version),
      [1, 2, 10],
    );
  });

  it('rejects a filename that does not carry a version', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'init.sql'), 'CREATE TABLE a (x);');
    assert.throws(() => loadMigrations(dir), /must look like 001_description\.sql/);
  });

  it('rejects two migrations sharing a version', () => {
    const dir = scratch();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');
    writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE b (x);');
    assert.throws(() => loadMigrations(dir), /Duplicate migration version 1/);
  });

  it('ignores non-.sql files', () => {
    const dir = scratch();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');
    writeFileSync(join(dir, 'README.md'), 'not a migration');
    assert.equal(loadMigrations(dir).length, 1);
  });
});

describe('migrate', () => {
  it('applies pending migrations in order and records them', () => {
    const db = openDb(':memory:');
    const dir = scratch();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (x);');

    assert.deepEqual(migrate(db, dir), [1, 2]);

    const applied = appliedMigrations(db);
    assert.deepEqual(
      applied.map((m) => m.version),
      [1, 2],
    );
    assert.deepEqual(
      applied.map((m) => m.name),
      ['a', 'b'],
    );
    assert.ok(applied.every((m) => m.checksum.length === 64));
    assert.ok(applied.every((m) => !Number.isNaN(Date.parse(m.applied_at))));
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const db = openDb(':memory:');
    const dir = scratch();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');

    assert.deepEqual(migrate(db, dir), [1]);
    assert.deepEqual(migrate(db, dir), [], 'second run must be a no-op');
    assert.equal(appliedMigrations(db).length, 1);
    db.close();
  });

  it('picks up a migration added after an earlier run', () => {
    const db = openDb(':memory:');
    const dir = scratch();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');
    migrate(db, dir);

    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (x);');
    assert.deepEqual(migrate(db, dir), [2]);
    db.close();
  });

  it('refuses to run when an applied migration file has changed', () => {
    const db = openDb(':memory:');
    const dir = scratch();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x);');
    migrate(db, dir);

    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (x, y);');
    assert.throws(() => migrate(db, dir), /has changed since it was applied/);
    db.close();
  });

  it('rolls back a failing migration, leaving no tracking row', () => {
    const db = openDb(':memory:');
    const dir = scratch();
    writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE a (x);');
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE b (x); THIS IS NOT SQL;');

    assert.throws(() => migrate(db, dir));

    // The good migration stays applied; the bad one left nothing behind, including
    // the table its first statement created.
    assert.deepEqual(
      appliedMigrations(db).map((m) => m.version),
      [1],
    );
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'b')")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((t) => t.name),
      ['a'],
      'the failing migration must not leave table b behind',
    );
    db.close();
  });
});
