import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { ingestPayments } from '../../src/ingest/payments.ts';
import { adapt } from '../helpers/adapter.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

const FIXTURE_NAME = 'testnet-payments-4539850-4539862';
const fixture = loadFixture(FIXTURE_NAME);

let server: FixtureServer;

before(async () => {
  server = await startFixtureServer(fixture);
});

after(async () => {
  await server.close();
});

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function client(): HorizonClient {
  return new HorizonClient({ baseUrl: server.baseUrl });
}

function range(): { fromLedger: number; toLedger: number } {
  return { fromLedger: fixture.fromLedger, toLedger: fixture.toLedger };
}

interface AssetVelocityRow {
  asset_code: string;
  asset_issuer: string;
  day: string;
  transfer_count: number;
  total_volume: number;
  distinct_senders: number;
  distinct_receivers: number;
}

describe('asset_velocity view', () => {
  it('is created by migration and present after fresh migrate', () => {
    const db = freshDb();
    const views = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'asset_velocity'`)
      .all();
    assert.equal(views.length, 1);
  });

  it('aggregates transfer metrics correctly against recorded testnet data', async () => {
    const db = freshDb();
    await ingestPayments(adapt(db), client(), range());

    const rows = db
      .prepare(
        `SELECT asset_code, asset_issuer, day, transfer_count, total_volume, distinct_senders, distinct_receivers
         FROM asset_velocity
         ORDER BY asset_code, asset_issuer, day`,
      )
      .all() as AssetVelocityRow[];

    // In the pinned testnet range, there are 7 native payments and 1 PYUSD payment
    assert.equal(rows.length, 2);

    const nativeRow = rows.find((r) => r.asset_code === 'native');
    assert.ok(nativeRow);
    assert.equal(nativeRow.asset_issuer, '');
    assert.equal(nativeRow.day, '2026-09-06');
    assert.equal(nativeRow.transfer_count, 7);
    assert.ok(nativeRow.total_volume > 0);
    assert.ok(nativeRow.distinct_senders > 0);
    assert.ok(nativeRow.distinct_receivers > 0);

    const pyusdRow = rows.find((r) => r.asset_code === 'PYUSD');
    assert.ok(pyusdRow);
    assert.notEqual(pyusdRow.asset_issuer, '');
    assert.equal(pyusdRow.day, '2026-09-06');
    assert.equal(pyusdRow.transfer_count, 1);
    assert.equal(pyusdRow.total_volume, 0.0000001);
    assert.equal(pyusdRow.distinct_senders, 1);
    assert.equal(pyusdRow.distinct_receivers, 1);
  });

  it('distinguishes transfer count from distinct counterparty counts', () => {
    const db = freshDb();
    const accountA = 'GA_SENDER_1';
    const accountB = 'GB_SENDER_2';
    const accountRec = 'GC_RECEIVER';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      100,
      '2026-09-04T12:00:00Z',
      3,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?), (?), (?)').run(
      accountA,
      accountB,
      accountRec,
    );

    // Two payments from A -> Rec, one payment from B -> Rec
    // Total transfers = 3, distinct senders = 2, distinct receivers = 1
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op1', 100, 'payment', accountA, '2026-09-04T10:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op1', accountA, accountRec, 'native', '', '10.0000000');

    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op2', 100, 'payment', accountA, '2026-09-04T11:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op2', accountA, accountRec, 'native', '', '20.0000000');

    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op3', 100, 'payment', accountB, '2026-09-04T12:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op3', accountB, accountRec, 'native', '', '30.0000000');

    const row = db
      .prepare(`SELECT * FROM asset_velocity WHERE asset_code = 'native'`)
      .get() as AssetVelocityRow;

    assert.ok(row);
    assert.equal(row.transfer_count, 3);
    assert.equal(row.total_volume, 60.0);
    assert.equal(row.distinct_senders, 2);
    assert.equal(row.distinct_receivers, 1);
  });

  it('supports composable rolling-window aggregation without wall-clock dependency', () => {
    const db = freshDb();
    const accountA = 'GA_WINDOW_A';
    const accountB = 'GB_WINDOW_B';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      200,
      '2026-09-01T00:00:00Z',
      3,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?), (?)').run(accountA, accountB);

    // Transfers across 3 separate days
    const days = ['2026-09-01', '2026-09-02', '2026-09-03'];
    for (let i = 0; i < days.length; i++) {
      const day = days[i]!;
      db.prepare(
        'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(`op_${i}`, 200, 'payment', accountA, `${day}T12:00:00Z`);
      db.prepare(
        'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(`op_${i}`, accountA, accountB, 'native', '', '100.0000000');
    }

    // Caller queries a 2-day rolling window: 2026-09-01 to 2026-09-02
    const windowResult = db
      .prepare(
        `SELECT
           asset_code,
           asset_issuer,
           SUM(transfer_count) AS window_transfer_count,
           SUM(total_volume) AS window_volume
         FROM asset_velocity
         WHERE day BETWEEN '2026-09-01' AND '2026-09-02'
         GROUP BY asset_code, asset_issuer`,
      )
      .get() as {
      asset_code: string;
      asset_issuer: string;
      window_transfer_count: number;
      window_volume: number;
    };

    assert.ok(windowResult);
    assert.equal(windowResult.window_transfer_count, 2);
    assert.equal(windowResult.window_volume, 200.0);
  });
});
