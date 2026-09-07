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

interface TopAccountRow {
  account_id: string;
  asset_code: string;
  asset_issuer: string;
  day: string;
  sent_count: number;
  received_count: number;
  payment_count: number;
  sent_volume: number;
  received_volume: number;
  combined_volume: number;
}

describe('top_accounts_by_volume view', () => {
  it('is created by migration and present after fresh migrate', () => {
    const db = freshDb();
    const views = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'top_accounts_by_volume'`,
      )
      .all();
    assert.equal(views.length, 1);
  });

  it('aggregates volume metrics correctly against recorded testnet data', async () => {
    const db = freshDb();
    await ingestPayments(db, client(), range());

    const rows = db
      .prepare(
        `SELECT * FROM top_accounts_by_volume
         ORDER BY combined_volume DESC, account_id ASC`,
      )
      .all() as TopAccountRow[];

    assert.ok(rows.length > 0);

    for (const r of rows) {
      assert.equal(
        r.payment_count,
        r.sent_count + r.received_count,
        'payment_count must equal sent_count + received_count',
      );
      assert.equal(
        Math.round((r.sent_volume + r.received_volume) * 1e7) / 1e7,
        Math.round(r.combined_volume * 1e7) / 1e7,
        'combined_volume must equal sent_volume + received_volume',
      );
    }
  });

  it('ranks accounts deterministically using tiebreaker on equal volumes', () => {
    const db = freshDb();
    const accountA = 'GA_ACCOUNT_A_TIED';
    const accountB = 'GB_ACCOUNT_B_TIED';
    const accountSink = 'GC_SINK';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      100,
      '2026-09-04T12:00:00Z',
      2,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?), (?), (?)').run(
      accountA,
      accountB,
      accountSink,
    );

    // Account A sends 500 XLM
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op1', 100, 'payment', accountA, '2026-09-04T10:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op1', accountA, accountSink, 'native', '', '500.0000000');

    // Account B sends 500 XLM (exact tie in volume)
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op2', 100, 'payment', accountB, '2026-09-04T11:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op2', accountB, accountSink, 'native', '', '500.0000000');

    const runQuery = () =>
      db
        .prepare(
          `SELECT account_id, combined_volume
           FROM top_accounts_by_volume
           WHERE account_id IN (?, ?)
           ORDER BY combined_volume DESC, account_id ASC`,
        )
        .all(accountA, accountB) as { account_id: string; combined_volume: number }[];

    const result1 = runQuery();
    const result2 = runQuery();

    assert.deepEqual(result1, result2, 'ranking output must be deterministic across runs');
    assert.equal(
      result1[0]!.account_id,
      accountA,
      'accountA must sort before accountB by tiebreaker',
    );
  });

  it('supports ranking by sent, received, or combined volume separately', () => {
    const db = freshDb();
    const sender = 'GA_PURE_SENDER';
    const receiver = 'GB_PURE_RECEIVER';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      200,
      '2026-09-04T12:00:00Z',
      1,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?), (?)').run(sender, receiver);

    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op_rank', 200, 'payment', sender, '2026-09-04T10:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op_rank', sender, receiver, 'native', '', '250.0000000');

    // Rank by sent volume
    const topSent = db
      .prepare(
        `SELECT account_id, sent_volume FROM top_accounts_by_volume ORDER BY sent_volume DESC LIMIT 1`,
      )
      .get() as { account_id: string; sent_volume: number };
    assert.equal(topSent.account_id, sender);
    assert.equal(topSent.sent_volume, 250.0);

    // Rank by received volume
    const topReceived = db
      .prepare(
        `SELECT account_id, received_volume FROM top_accounts_by_volume ORDER BY received_volume DESC LIMIT 1`,
      )
      .get() as { account_id: string; received_volume: number };
    assert.equal(topReceived.account_id, receiver);
    assert.equal(topReceived.received_volume, 250.0);
  });
});
