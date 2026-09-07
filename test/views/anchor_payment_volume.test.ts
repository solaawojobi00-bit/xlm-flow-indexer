import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { loadAnchorIssuers } from '../../src/db/anchors.ts';
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

const TESTNET_PAXOS_ISSUER = 'GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G';

interface AnchorPaymentVolumeRow {
  issuer_account_id: string;
  anchor_name: string | null;
  home_domain: string | null;
  asset_code: string;
  day: string;
  payment_count: number;
  total_volume: number;
}

describe('anchor_payment_volume view and loader', () => {
  it('creates anchor_issuers table and anchor_payment_volume view on migration', () => {
    const db = freshDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'anchor_issuers'`)
      .all();
    const views = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'anchor_payment_volume'`,
      )
      .all();

    assert.equal(tables.length, 1);
    assert.equal(views.length, 1);
  });

  it('populates anchor_issuers idempotently via loadAnchorIssuers', () => {
    const db = freshDb();
    const config = [
      {
        account_id: TESTNET_PAXOS_ISSUER,
        name: 'Paxos (Testnet)',
        home_domain: 'paxos.com',
      },
    ];

    const count1 = loadAnchorIssuers(db, config);
    assert.equal(count1, 1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM anchor_issuers').get() as { c: number }).c, 1);

    // Re-running with updated name should update rather than duplicate or fail
    const updatedConfig = [
      {
        account_id: TESTNET_PAXOS_ISSUER,
        name: 'Paxos Lab',
        home_domain: 'paxos.com',
      },
    ];
    const count2 = loadAnchorIssuers(db, updatedConfig);
    assert.equal(count2, 1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM anchor_issuers').get() as { c: number }).c, 1);

    const row = db
      .prepare('SELECT * FROM anchor_issuers WHERE account_id = ?')
      .get(TESTNET_PAXOS_ISSUER) as { name: string; home_domain: string };
    assert.equal(row.name, 'Paxos Lab');
  });

  it('populates anchor_issuers from a JSON config file path', () => {
    const db = freshDb();
    const count = loadAnchorIssuers(db, 'config/anchors.json');
    assert.ok(count >= 1);

    const rows = db.prepare('SELECT * FROM anchor_issuers').all();
    assert.ok(rows.length >= 1);
  });

  it('aggregates anchor payment volume correctly against recorded testnet data', async () => {
    const db = freshDb();
    loadAnchorIssuers(db, [
      {
        account_id: TESTNET_PAXOS_ISSUER,
        name: 'Paxos Testnet',
        home_domain: 'paxos.com',
      },
    ]);

    await ingestPayments(db, client(), range());

    const rows = db
      .prepare(`SELECT * FROM anchor_payment_volume`)
      .all() as AnchorPaymentVolumeRow[];

    assert.equal(rows.length, 1, 'only the configured PYUSD anchor payment should match');
    const paxos = rows[0]!;
    assert.equal(paxos.issuer_account_id, TESTNET_PAXOS_ISSUER);
    assert.equal(paxos.anchor_name, 'Paxos Testnet');
    assert.equal(paxos.home_domain, 'paxos.com');
    assert.equal(paxos.asset_code, 'PYUSD');
    assert.equal(paxos.day, '2026-09-06');
    assert.equal(paxos.payment_count, 1);
    assert.equal(paxos.total_volume, 0.0000001);
  });

  it('excludes payments whose issuer is not in anchor_issuers', async () => {
    const db = freshDb();
    // Configure an anchor issuer that is NOT present in the payments data
    loadAnchorIssuers(db, [
      {
        account_id: 'G_OTHER_ANCHOR_NOT_IN_PAYMENTS_DATA',
        name: 'Other Anchor',
        home_domain: 'other.org',
      },
    ]);

    await ingestPayments(db, client(), range());

    const rows = db.prepare(`SELECT * FROM anchor_payment_volume`).all();
    assert.equal(rows.length, 0, 'non-configured anchor payments must not appear in the view');
  });

  it('excludes native payments (asset_issuer = "") even if anchor table is misconfigured', () => {
    const db = freshDb();
    const sender = 'GA_NATIVE_SENDER';
    const receiver = 'GB_NATIVE_RECEIVER';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      500,
      '2026-09-04T12:00:00Z',
      1,
    );
    db.prepare('INSERT INTO accounts (account_id) VALUES (?), (?)').run(sender, receiver);

    // Native payment with asset_issuer = ''
    db.prepare(
      'INSERT INTO operations (id, ledger_sequence, type, source_account, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('op_native', 500, 'payment', sender, '2026-09-04T12:00:00Z');
    db.prepare(
      'INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('op_native', sender, receiver, 'native', '', '1000.0000000');

    // Attempting to insert empty-string issuer directly into anchor_issuers is rejected by table CHECK
    assert.throws(() => {
      db.prepare('INSERT INTO anchor_issuers (account_id, name) VALUES (?, ?)').run(
        '',
        'Bogus Anchor',
      );
    }, /CHECK/);

    // And loader also rejects empty string
    assert.throws(() => {
      loadAnchorIssuers(db, [{ account_id: '', name: 'Empty' }]);
    }, /cannot be empty/);

    // View returns 0 rows for native payments
    const rows = db.prepare(`SELECT * FROM anchor_payment_volume`).all();
    assert.equal(rows.length, 0);
  });
});
