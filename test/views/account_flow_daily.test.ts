import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { ingestPayments } from '../../src/ingest/payments.ts';
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

interface AccountFlowDailyRow {
  account_id: string;
  asset_code: string;
  asset_issuer: string;
  day: string;
  inbound: number;
  outbound: number;
  net: number;
}

describe('account_flow_daily view', () => {
  it('is created by migration and present after fresh migrate', () => {
    const db = freshDb();
    const views = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'account_flow_daily'`)
      .all();
    assert.equal(views.length, 1);
  });

  it('aggregates daily flow correctly against recorded testnet data', async () => {
    const db = freshDb();
    await ingestPayments(db, client(), range());

    const rows = db
      .prepare(
        `SELECT account_id, asset_code, asset_issuer, day, inbound, outbound, net
         FROM account_flow_daily
         ORDER BY account_id, asset_code, asset_issuer, day`,
      )
      .all() as AccountFlowDailyRow[];

    // Verify all rows have net = inbound - outbound
    for (const r of rows) {
      assert.equal(
        Math.round((r.inbound - r.outbound) * 1e7) / 1e7,
        Math.round(r.net * 1e7) / 1e7,
        `net must equal inbound - outbound for account ${r.account_id}`,
      );
    }

    // Pinned testnet range contains both native XLM payments and an issued asset payment (PYUSD)
    const nativeRows = rows.filter((r) => r.asset_code === 'native');
    const issuedRows = rows.filter((r) => r.asset_code !== 'native');

    assert.ok(nativeRows.length > 0, 'must contain native asset flows');
    assert.ok(issuedRows.length > 0, 'must contain issued asset flows');

    for (const r of nativeRows) {
      assert.equal(r.asset_issuer, '', 'native asset must have empty string issuer');
    }

    for (const r of issuedRows) {
      assert.notEqual(r.asset_issuer, '', 'issued asset must have non-empty issuer');
    }
  });

  it('consolidates both inbound and outbound payments on the same day into one row', () => {
    const db = freshDb();
    const accountA = 'GA_TEST_ACCOUNT_A';
    const accountB = 'GB_TEST_ACCOUNT_B';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      100,
      '2026-09-04T12:00:00Z',
      2,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?), (?)').run(accountA, accountB);

    // Op 1: A pays B 100 XLM on 2026-09-04
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op_1', 100, 'payment', accountA, '2026-09-04T10:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op_1', accountA, accountB, 'native', '', '100.0000000');

    // Op 2: B pays A 40 XLM on 2026-09-04 (same day)
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op_2', 100, 'payment', accountB, '2026-09-04T15:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op_2', accountB, accountA, 'native', '', '40.0000000');

    const rowsA = db
      .prepare(`SELECT * FROM account_flow_daily WHERE account_id = ?`)
      .all(accountA) as AccountFlowDailyRow[];

    assert.equal(rowsA.length, 1, 'account A must have exactly 1 row for the day');
    const rowA = rowsA[0]!;
    assert.equal(rowA.day, '2026-09-04');
    assert.equal(rowA.inbound, 40.0);
    assert.equal(rowA.outbound, 100.0);
    assert.equal(rowA.net, -60.0);

    const rowsB = db
      .prepare(`SELECT * FROM account_flow_daily WHERE account_id = ?`)
      .all(accountB) as AccountFlowDailyRow[];

    assert.equal(rowsB.length, 1, 'account B must have exactly 1 row for the day');
    const rowB = rowsB[0]!;
    assert.equal(rowB.day, '2026-09-04');
    assert.equal(rowB.inbound, 100.0);
    assert.equal(rowB.outbound, 40.0);
    assert.equal(rowB.net, 60.0);
  });

  it('handles self-payments by inflating inbound and outbound equally while netting to zero', () => {
    const db = freshDb();
    const account = 'GA_SELF_TEST_ACCOUNT';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      200,
      '2026-09-04T12:00:00Z',
      1,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run(account);

    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op_self', 200, 'payment', account, '2026-09-04T11:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op_self', account, account, 'native', '', '50.0000000');

    const row = db
      .prepare(`SELECT * FROM account_flow_daily WHERE account_id = ?`)
      .get(account) as AccountFlowDailyRow;

    assert.ok(row);
    assert.equal(row.inbound, 50.0);
    assert.equal(row.outbound, 50.0);
    assert.equal(row.net, 0.0);
  });

  it('buckets timestamps by UTC date', () => {
    const db = freshDb();
    const account = 'GA_DATE_BUCKET_TEST';
    const recipient = 'GB_RECIPIENT_TEST';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      300,
      '2026-09-04T23:59:59Z',
      2,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?), (?)').run(account, recipient);

    // One payment right before midnight UTC
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op_day1', 300, 'payment', account, '2026-09-04T23:59:59Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op_day1', account, recipient, 'native', '', '10.0000000');

    // Second payment right after midnight UTC (next day)
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op_day2', 300, 'payment', account, '2026-09-05T00:00:01Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op_day2', account, recipient, 'native', '', '20.0000000');

    const rows = db
      .prepare(`SELECT * FROM account_flow_daily WHERE account_id = ? ORDER BY day`)
      .all(account) as AccountFlowDailyRow[];

    assert.equal(rows.length, 2);
    const row0 = rows[0]!;
    const row1 = rows[1]!;
    assert.equal(row0.day, '2026-09-04');
    assert.equal(row0.outbound, 10.0);
    assert.equal(row1.day, '2026-09-05');
    assert.equal(row1.outbound, 20.0);
  });
});
