import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { SqlAdapter } from '../../src/db/adapter.ts';
import { isoStringOf } from '../../src/db/adapter.ts';
import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { sqliteAdapter } from '../../src/db/sqlite-adapter.ts';

/**
 * The SQLite half of the adapter contract (issue #67).
 *
 * These cases are written against `SqlAdapter`, not against better-sqlite3, so
 * the Postgres adapter can be dropped into the same table when it lands and the
 * two engines are held to one contract rather than two.
 *
 * Run against the real migrated schema rather than a scratch table: the counts
 * these methods report are what every `IngestResult` is built from, and
 * `ON CONFLICT DO NOTHING` behaving as the jobs assume is the property worth
 * pinning.
 */

function fresh(): { db: Db; sql: SqlAdapter } {
  const db = openDb(':memory:');
  migrate(db);
  return { db, sql: sqliteAdapter(db) };
}

function countOf(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

const INSERT_ACCOUNT = 'INSERT INTO accounts (account_id) VALUES (?) ON CONFLICT DO NOTHING';

describe('sqliteAdapter', () => {
  it('reports itself as the sqlite dialect', () => {
    assert.equal(fresh().sql.dialect, 'sqlite');
  });

  it('reports rows actually written', async () => {
    const { sql } = fresh();
    assert.equal((await sql.run(INSERT_ACCOUNT, ['GONE'])).rowsAffected, 1);
  });

  it('reports zero when ON CONFLICT DO NOTHING suppressed the write', async () => {
    // The property every "written" counter in src/ingest/ depends on: a row
    // already present must count as not written, or re-running a range would
    // report the whole range as fresh work.
    const { sql } = fresh();
    await sql.run(INSERT_ACCOUNT, ['GONE']);

    assert.equal((await sql.run(INSERT_ACCOUNT, ['GONE'])).rowsAffected, 0);
  });

  it('returns undefined from get when nothing matched', async () => {
    const { sql } = fresh();
    assert.equal(
      await sql.get('SELECT account_id FROM accounts WHERE account_id = ?', ['nope']),
      undefined,
    );
  });

  it('returns an empty array from all when nothing matched', async () => {
    const { sql } = fresh();
    assert.deepEqual(await sql.all('SELECT account_id FROM accounts'), []);
  });

  it('binds parameters positionally', async () => {
    const { sql } = fresh();
    await sql.run(INSERT_ACCOUNT, ['GALICE']);
    await sql.run(INSERT_ACCOUNT, ['GBOB']);

    const row = await sql.get<{ account_id: string }>(
      'SELECT account_id FROM accounts WHERE account_id = ?',
      ['GBOB'],
    );
    assert.equal(row?.account_id, 'GBOB');
  });

  it('binds a boolean, which better-sqlite3 refuses on its own', async () => {
    // SqlParam admits booleans because pg binds them natively. SQLite does not,
    // so the adapter converts -- without it this throws rather than returning a
    // row, and a caller would have to know which engine it was talking to.
    const { sql } = fresh();
    const row = await sql.get<{ flag: number }>('SELECT ? AS flag', [true]);
    assert.equal(row?.flag, 1);
  });

  it('reuses one compiled statement for repeated SQL', async () => {
    // The cache is what replaces the jobs' old hoisted `prepare`. Its effect is
    // invisible by design, so this asserts the observable part: the same SQL
    // string executed many times keeps behaving correctly rather than, say,
    // rebinding against a stale statement.
    const { db, sql } = fresh();
    for (let i = 0; i < 50; i++) {
      assert.equal((await sql.run(INSERT_ACCOUNT, [`G${String(i)}`])).rowsAffected, 1);
    }
    assert.equal(countOf(db, 'accounts'), 50);
  });
});

describe('sqliteAdapter transactions', () => {
  it('commits the work when the callback returns', async () => {
    const { db, sql } = fresh();

    const returned = await sql.transaction(async (tx) => {
      await tx.run(INSERT_ACCOUNT, ['GALICE']);
      await tx.run(INSERT_ACCOUNT, ['GBOB']);
      return 'done';
    });

    assert.equal(returned, 'done');
    assert.equal(countOf(db, 'accounts'), 2);
  });

  it('survives a real await between statements', async () => {
    // The reason the adapter issues BEGIN/COMMIT by hand instead of using
    // better-sqlite3's `db.transaction()`: that helper runs its callback to
    // completion synchronously, so an async callback would return a pending
    // promise and the transaction would commit before any awaited statement ran.
    // Nothing about that is a type error, so it needs a test.
    const { db, sql } = fresh();

    await sql.transaction(async (tx) => {
      await tx.run(INSERT_ACCOUNT, ['GEARLY']);
      await delay(5);
      await tx.run(INSERT_ACCOUNT, ['GLATE']);
    });

    assert.equal(countOf(db, 'accounts'), 2, 'both sides of the await must be committed');
  });

  it('rolls back every statement when the callback throws', async () => {
    const { db, sql } = fresh();
    await sql.run(INSERT_ACCOUNT, ['GBEFORE']);

    await assert.rejects(
      () =>
        sql.transaction(async (tx) => {
          await tx.run(INSERT_ACCOUNT, ['GDOOMED']);
          throw new Error('bad entry');
        }),
      /bad entry/,
    );

    assert.equal(countOf(db, 'accounts'), 1, 'only the pre-transaction row survives');
    assert.equal(
      await sql.get('SELECT account_id FROM accounts WHERE account_id = ?', ['GDOOMED']),
      undefined,
    );
  });

  it('leaves the connection usable after a rollback', async () => {
    const { db, sql } = fresh();

    await assert.rejects(
      () =>
        sql.transaction(async (tx) => {
          await tx.run(INSERT_ACCOUNT, ['GDOOMED']);
          throw new Error('bad entry');
        }),
      /bad entry/,
    );

    await sql.run(INSERT_ACCOUNT, ['GAFTER']);
    assert.equal(countOf(db, 'accounts'), 1);
  });

  it('refuses to nest', async () => {
    // SQLite has no nested transactions, so an inner block would be committing
    // or rolling back the outer one. Failing loudly beats appearing to work.
    const { sql } = fresh();

    await assert.rejects(
      () => sql.transaction((tx) => tx.transaction(() => Promise.resolve())),
      /Nested SqlAdapter\.transaction\(\) is not supported/,
    );
  });

  it('can open a new transaction after one failed', async () => {
    const { db, sql } = fresh();

    await assert.rejects(() => sql.transaction(() => Promise.reject(new Error('nope'))), /nope/);

    await sql.transaction(async (tx) => {
      await tx.run(INSERT_ACCOUNT, ['GNEXT']);
    });
    assert.equal(countOf(db, 'accounts'), 1, 'the nesting guard must have been released');
  });
});

describe('sqliteAdapter close', () => {
  it('leaves the borrowed handle open by default', async () => {
    // The adapter normally wraps a handle someone else opened and is still
    // using -- the CLI closes its own in a finally, and the suites keep theirs
    // for assertions.
    const { db, sql } = fresh();
    await sql.close();

    assert.equal(db.open, true);
  });

  it('closes the handle when given ownership', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const sql = sqliteAdapter(db, { closeHandle: true });

    await sql.close();
    assert.equal(db.open, false);
  });

  it('is safe to call twice', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const sql = sqliteAdapter(db, { closeHandle: true });

    await sql.close();
    await sql.close();
    assert.equal(db.open, false);
  });
});

describe('isoStringOf', () => {
  it('passes a SQLite TEXT timestamp through unchanged', () => {
    // SQLite stores ISO8601 text and the driver hands back exactly that string.
    assert.equal(isoStringOf('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00Z');
  });

  it('renders a Date as ISO8601', () => {
    // What pg returns for the same column as TIMESTAMPTZ. Both drivers have to
    // end up at one type, because AppliedMigration and IngestState promise one.
    assert.equal(isoStringOf(new Date(Date.UTC(2026, 0, 1))), '2026-01-01T00:00:00.000Z');
  });
});
