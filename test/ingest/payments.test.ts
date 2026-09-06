import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { cursorBeforeLedger, ledgerOf } from '../../src/horizon/toid.ts';
import { ingestPayments, normaliseAsset, PAYMENT_TYPES } from '../../src/ingest/payments.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

const FIXTURE_NAME = 'testnet-4539850-4539862';
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

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

describe('toid', () => {
  it('extracts the ledger sequence from a paging token', () => {
    // Verified against live Horizon during capture: this token is in ledger 4539850.
    assert.equal(ledgerOf('19498507278745600'), 4539850);
  });

  it('builds a cursor immediately before a ledger', () => {
    assert.equal(cursorBeforeLedger(4539850), '19498507278745599');
    assert.equal(ledgerOf(cursorBeforeLedger(4539850)), 4539849);
  });

  it('rejects a nonsense ledger sequence', () => {
    assert.throws(() => cursorBeforeLedger(0), RangeError);
    assert.throws(() => cursorBeforeLedger(-1), RangeError);
    assert.throws(() => cursorBeforeLedger(1.5), RangeError);
  });
});

describe('normaliseAsset', () => {
  it('encodes native as native/empty string, never NULL', () => {
    // Horizon omits asset_code and asset_issuer entirely for native.
    assert.deepEqual(normaliseAsset({ asset_type: 'native' }), { code: 'native', issuer: '' });
  });

  it('keeps code and issuer for an issued asset', () => {
    assert.deepEqual(
      normaliseAsset({
        asset_type: 'credit_alphanum4',
        asset_code: 'PYUSD',
        asset_issuer: 'GBT2KJDK',
      }),
      { code: 'PYUSD', issuer: 'GBT2KJDK' },
    );
  });

  it('treats a missing code as native rather than writing an empty code', () => {
    assert.deepEqual(normaliseAsset({}), { code: 'native', issuer: '' });
  });
});

describe('payment type filter', () => {
  it('covers the three value-transfer operation types', () => {
    assert.deepEqual([...PAYMENT_TYPES].sort(), [
      'path_payment_strict_receive',
      'path_payment_strict_send',
      'payment',
    ]);
  });

  it('excludes create_account and account_merge', () => {
    // Both move value but are out of scope for BACKLOG.md item 3. Asserted so that
    // widening the filter is a deliberate edit rather than an accident.
    assert.ok(!PAYMENT_TYPES.has('create_account'));
    assert.ok(!PAYMENT_TYPES.has('account_merge'));
  });
});

describe('ingestPayments against recorded testnet data', () => {
  it('ingests the pinned range', async () => {
    const db = freshDb();
    const result = await ingestPayments(db, client(), range());

    assert.equal(result.ledgersWritten, 13, 'ledgers 4539850-4539862 inclusive');
    assert.equal(result.operationsScanned, 140);
    assert.equal(result.paymentsSeen, 8);
    assert.equal(result.paymentsWritten, 8);

    assert.equal(count(db, 'ledgers'), 13);
    assert.equal(count(db, 'payments'), 8);
    assert.equal(count(db, 'operations'), 8, 'only payment-type operations are stored');
    db.close();
  });

  it('records both native and issued assets from real data', async () => {
    const db = freshDb();
    await ingestPayments(db, client(), range());

    const byAsset = db
      .prepare(
        `SELECT asset_code, asset_issuer, COUNT(*) n
         FROM payments GROUP BY asset_code, asset_issuer ORDER BY asset_code`,
      )
      .all() as { asset_code: string; asset_issuer: string; n: number }[];

    assert.deepEqual(byAsset, [
      {
        asset_code: 'PYUSD',
        asset_issuer: 'GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G',
        n: 1,
      },
      { asset_code: 'native', asset_issuer: '', n: 7 },
    ]);
    db.close();
  });

  it('writes native issuer as empty string, never NULL', async () => {
    const db = freshDb();
    await ingestPayments(db, client(), range());

    const nulls = (
      db.prepare('SELECT COUNT(*) c FROM payments WHERE asset_issuer IS NULL').get() as {
        c: number;
      }
    ).c;
    assert.equal(nulls, 0);
    db.close();
  });

  it('stores amounts exactly as Horizon sent them', async () => {
    const db = freshDb();
    await ingestPayments(db, client(), range());

    // Pull the amounts straight out of the recorded response and compare to what
    // landed in the table. Any numeric round-trip in the write path shows up here.
    const opsPage = fixture.responses[
      `/operations?cursor=${cursorBeforeLedger(fixture.fromLedger)}&order=asc&limit=200`
    ] as { _embedded: { records: { id: string; type: string; amount?: string }[] } };

    const expected = new Map(
      opsPage._embedded.records
        .filter((o) => PAYMENT_TYPES.has(o.type) && o.amount !== undefined)
        .map((o) => [o.id, o.amount]),
    );

    const stored = db.prepare('SELECT operation_id, amount FROM payments').all() as {
      operation_id: string;
      amount: string;
    }[];

    assert.ok(stored.length > 0);
    for (const row of stored) {
      assert.equal(
        row.amount,
        expected.get(row.operation_id),
        `amount drift on ${row.operation_id}`,
      );
      assert.equal(typeof row.amount, 'string');
    }
    db.close();
  });

  it('is idempotent: re-ingesting the same range writes nothing', async () => {
    const db = freshDb();
    await ingestPayments(db, client(), range());

    const before = {
      ledgers: count(db, 'ledgers'),
      accounts: count(db, 'accounts'),
      operations: count(db, 'operations'),
      payments: count(db, 'payments'),
    };

    const second = await ingestPayments(db, client(), range());

    assert.equal(second.ledgersWritten, 0);
    assert.equal(second.accountsWritten, 0);
    assert.equal(second.operationsWritten, 0);
    assert.equal(second.paymentsWritten, 0);

    assert.deepEqual(
      {
        ledgers: count(db, 'ledgers'),
        accounts: count(db, 'accounts'),
        operations: count(db, 'operations'),
        payments: count(db, 'payments'),
      },
      before,
      'row counts must be unchanged after a second run',
    );

    // The second run still reads Horizon and still sees the same payments; what it
    // must not do is write them again.
    assert.equal(second.paymentsSeen, 8);
    db.close();
  });

  it('writes parent rows so every foreign key resolves', async () => {
    const db = freshDb();
    await ingestPayments(db, client(), range());

    const violations = db.pragma('foreign_key_check') as unknown[];
    assert.deepEqual(violations, [], 'no orphan rows');

    const orphanOps = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM operations o
           LEFT JOIN ledgers l ON l.sequence = o.ledger_sequence WHERE l.sequence IS NULL`,
        )
        .get() as { c: number }
    ).c;
    assert.equal(orphanOps, 0);
    db.close();
  });

  it('stops at toLedger rather than draining the page', async () => {
    // The recorded operations page holds 200 records spanning past 4539862. Ingesting
    // a narrower range must stop on ledger sequence, not on the page boundary.
    const db = freshDb();
    const narrow = await ingestPayments(db, client(), {
      fromLedger: fixture.fromLedger,
      toLedger: fixture.fromLedger + 2,
    });

    assert.ok(narrow.operationsScanned < 140, 'must scan fewer operations than the full range');
    assert.equal(count(db, 'ledgers'), 3);

    const maxLedger = (
      db.prepare('SELECT MAX(ledger_sequence) m FROM operations').get() as { m: number | null }
    ).m;
    if (maxLedger !== null) {
      assert.ok(maxLedger <= fixture.fromLedger + 2);
    }
    db.close();
  });

  it('rejects an inverted range', async () => {
    const db = freshDb();
    await assert.rejects(
      () => ingestPayments(db, client(), { fromLedger: 100, toLedger: 50 }),
      RangeError,
    );
    db.close();
  });
});

describe('fixture provenance', () => {
  it('records where and when the data came from', () => {
    assert.equal(fixture.networkPassphrase, 'Test SDF Network ; September 2015');
    assert.equal(fixture.horizonUrl, 'https://horizon-testnet.stellar.org');
    assert.ok(!Number.isNaN(Date.parse(fixture.capturedAt)));
    assert.match(fixture.horizonVersion, /^\d+\./);
  });

  it('serves only requests that were actually recorded', async () => {
    // A missing fixture must 404 rather than return an empty page: an empty page is a
    // legitimate end-of-range signal and would silently truncate ingestion, turning a
    // missing recording into a passing test.
    const c = new HorizonClient({ baseUrl: server.baseUrl, maxRetries: 0 });
    await assert.rejects(() => c.getPage('/operations', { cursor: 'not-recorded' }));
  });
});
