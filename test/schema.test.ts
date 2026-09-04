import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openDb, type Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';

function migrated(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** Seed the parent rows the child tables' foreign keys require. */
function seedParents(db: Db, account = 'GACCOUNT1'): void {
  db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
    1,
    '2026-01-01T00:00:00Z',
    1,
  );
  db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run(account);
}

describe('schema', () => {
  it('creates the six Phase 1 tables', () => {
    const db = migrated();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);

    for (const expected of [
      'accounts',
      'ledgers',
      'operations',
      'payments',
      'trades',
      'trustlines',
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
    db.close();
  });

  it('creates the five ARCHITECTURE.md indexes', () => {
    const db = migrated();
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .all() as Array<{ name: string }>
    ).map((i) => i.name);

    assert.deepEqual(indexes.sort(), [
      'idx_operations_created_at',
      'idx_payments_asset',
      'idx_payments_from_account',
      'idx_payments_to_account',
      'idx_trades_executed_at',
    ]);
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = migrated();
    // No ledger 999 and no such account: this must be rejected, which only happens
    // if PRAGMA foreign_keys is on. SQLite silently ignores REFERENCES otherwise.
    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run('op1', 999, 'payment', 'GNOSUCH', '2026-01-01T00:00:00Z'),
      /FOREIGN KEY constraint failed/,
    );
    db.close();
  });
});

describe('native asset issuer handling (issue #1 amendment 1)', () => {
  it('rejects a duplicate native trustline', () => {
    const db = migrated();
    seedParents(db);

    const insert = db.prepare(
      'INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('GACCOUNT1', 'native', '', '2026-01-01T00:00:00Z');

    // This is the regression test the amendment exists for. With the issuer column
    // nullable and NULL used for native, SQLite would accept this second insert and
    // the primary key backing idempotency would not hold.
    assert.throws(
      () => insert.run('GACCOUNT1', 'native', '', '2026-01-02T00:00:00Z'),
      /UNIQUE constraint failed/,
    );

    assert.equal(
      (db.prepare('SELECT COUNT(*) c FROM trustlines').get() as { c: number }).c,
      1,
    );
    db.close();
  });

  it('rejects NULL in asset_issuer outright', () => {
    const db = migrated();
    seedParents(db);

    assert.throws(
      () =>
        db
          .prepare(
            'INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at) VALUES (?, ?, ?, ?)',
          )
          .run('GACCOUNT1', 'native', null, '2026-01-01T00:00:00Z'),
      /NOT NULL constraint failed/,
    );
    db.close();
  });

  it('demonstrates the SQLite quirk the amendment avoids', () => {
    // Proves the amendment is load-bearing rather than cosmetic: build trustlines
    // exactly as ARCHITECTURE.md originally specified it, with a nullable issuer,
    // and show SQLite accepts unlimited duplicate native rows despite the primary
    // key. If a future SQLite version changes this, this test fails and tells us
    // the constraint we designed around no longer applies.
    const db = openDb(':memory:');
    db.exec(`
      CREATE TABLE trustlines_as_documented (
        account_id     TEXT,
        asset_code     TEXT,
        asset_issuer   TEXT,
        established_at TEXT,
        PRIMARY KEY (account_id, asset_code, asset_issuer)
      )
    `);

    const insert = db.prepare(
      'INSERT INTO trustlines_as_documented VALUES (?, ?, ?, ?)',
    );
    insert.run('GACCOUNT1', 'native', null, '2026-01-01T00:00:00Z');
    insert.run('GACCOUNT1', 'native', null, '2026-01-02T00:00:00Z');
    insert.run('GACCOUNT1', 'native', null, '2026-01-03T00:00:00Z');

    assert.equal(
      (
        db.prepare('SELECT COUNT(*) c FROM trustlines_as_documented').get() as { c: number }
      ).c,
      3,
      'SQLite is expected to allow duplicate NULL-issuer rows despite the primary key',
    );
    db.close();
  });

  it('defaults asset_issuer to empty string when omitted', () => {
    const db = migrated();
    seedParents(db);
    db.prepare(
      'INSERT INTO trustlines (account_id, asset_code, established_at) VALUES (?, ?, ?)',
    ).run('GACCOUNT1', 'native', '2026-01-01T00:00:00Z');

    assert.equal(
      (db.prepare('SELECT asset_issuer FROM trustlines').get() as { asset_issuer: string })
        .asset_issuer,
      '',
    );
    db.close();
  });
});

describe('trades issuer columns (issue #1 amendment 2)', () => {
  it('distinguishes same-code assets from different issuers', () => {
    const db = migrated();
    seedParents(db);

    const insert = db.prepare(`
      INSERT INTO trades (
        id, ledger_sequence,
        base_asset_code, base_asset_issuer,
        counter_asset_code, counter_asset_issuer,
        base_amount, counter_amount, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Two USDC assets from different issuers traded against native. Without the
    // issuer columns these would be indistinguishable and trade_pair_activity
    // (issue #10) would merge them into one pair with summed volume.
    insert.run('t1', 1, 'native', '', 'USDC', 'GISSUERA', '100.0000000', '10.0000000', '2026-01-01T00:00:00Z');
    insert.run('t2', 1, 'native', '', 'USDC', 'GISSUERB', '200.0000000', '20.0000000', '2026-01-01T00:01:00Z');

    const pairs = db
      .prepare(`
        SELECT counter_asset_code, counter_asset_issuer, COUNT(*) trades
        FROM trades
        GROUP BY base_asset_code, base_asset_issuer, counter_asset_code, counter_asset_issuer
        ORDER BY counter_asset_issuer
      `)
      .all() as Array<{ counter_asset_code: string; counter_asset_issuer: string; trades: number }>;

    assert.equal(pairs.length, 2, 'two issuers must produce two pair rows');
    assert.deepEqual(
      pairs.map((p) => p.counter_asset_issuer),
      ['GISSUERA', 'GISSUERB'],
    );
    db.close();
  });

  it('stores amounts as text without float round-tripping', () => {
    const db = migrated();
    seedParents(db);
    // A value that loses precision as an IEEE-754 double, which is why
    // ARCHITECTURE.md specifies TEXT storage with casting at query time.
    const amount = '9007199254740993.0000001';
    db.prepare(`
      INSERT INTO trades (
        id, ledger_sequence, base_asset_code, base_asset_issuer,
        counter_asset_code, counter_asset_issuer, base_amount, counter_amount, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('t1', 1, 'native', '', 'USDC', 'GISSUERA', amount, '1.0000000', '2026-01-01T00:00:00Z');

    assert.equal(
      (db.prepare('SELECT base_amount FROM trades').get() as { base_amount: string }).base_amount,
      amount,
    );
    db.close();
  });
});
