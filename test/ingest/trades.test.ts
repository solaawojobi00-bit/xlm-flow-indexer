import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { appliedMigrations, migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { ledgerOf } from '../../src/horizon/toid.ts';
import { ingestTrades, TRADE_TYPES } from '../../src/ingest/trades.ts';
import { adapt } from '../helpers/adapter.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

const fixture = loadFixture('testnet-trades-4534150-4534300');

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

describe('migration 002', () => {
  it('is applied as its own migration, not an edit to 001', () => {
    // 001 was already applied and checksummed on merge, and the runner refuses to run
    // when an applied migration's content changes. Adding trade_type therefore had to
    // be a new migration -- this asserts both are present and ordered.
    const db = freshDb();
    const versions = appliedMigrations(db).map((m) => m.version);
    assert.ok(versions.includes(1) && versions.includes(2));
    assert.ok(versions.indexOf(1) < versions.indexOf(2));
    db.close();
  });

  it('constrains trade_type to the two known mechanisms', () => {
    const db = freshDb();
    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      1,
      '2026-01-01T00:00:00Z',
      1,
    );

    const insert = db.prepare(
      `INSERT INTO trades (
         id, ledger_sequence, base_asset_code, base_asset_issuer,
         counter_asset_code, counter_asset_issuer, base_amount, counter_amount,
         executed_at, trade_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    assert.throws(
      () =>
        insert.run(
          't-bad',
          1,
          'native',
          '',
          'USDC',
          'GISSUER',
          '1',
          '1',
          '2026-01-01T00:00:00Z',
          'something_new',
        ),
      /CHECK constraint failed/,
    );
    db.close();
  });

  it('defaults to orderbook when trade_type is omitted', () => {
    const db = freshDb();
    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      1,
      '2026-01-01T00:00:00Z',
      1,
    );
    db.prepare(
      `INSERT INTO trades (
         id, ledger_sequence, base_asset_code, base_asset_issuer,
         counter_asset_code, counter_asset_issuer, base_amount, counter_amount, executed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('t1', 1, 'native', '', 'USDC', 'GISSUER', '1', '1', '2026-01-01T00:00:00Z');

    assert.equal(
      (db.prepare('SELECT trade_type FROM trades').get() as { trade_type: string }).trade_type,
      'orderbook',
    );
    db.close();
  });
});

describe('ingestTrades against recorded testnet data', () => {
  it('ingests the pinned range', async () => {
    const db = freshDb();
    const result = await ingestTrades(adapt(db), client(), range());

    assert.equal(result.tradesSeen, 12);
    assert.equal(result.tradesWritten, 12);
    assert.equal(result.ledgersWritten, 151);
    assert.equal(result.skippedUnknownType, 0);
    db.close();
  });

  it('records both trade mechanisms rather than only order-book', async () => {
    // This is the scope decision made concrete. Liquidity-pool trades were roughly
    // half of all trades sampled on testnet, so dropping them would discard about
    // half of DEX activity that PRD.md names as a goal.
    const db = freshDb();
    const result = await ingestTrades(adapt(db), client(), range());

    assert.equal(result.orderbookTrades, 9);
    assert.equal(result.liquidityPoolTrades, 3);

    const byType = db
      .prepare('SELECT trade_type, COUNT(*) n FROM trades GROUP BY trade_type ORDER BY trade_type')
      .all() as { trade_type: string; n: number }[];

    assert.deepEqual(byType, [
      { trade_type: 'liquidity_pool', n: 3 },
      { trade_type: 'orderbook', n: 9 },
    ]);
    db.close();
  });

  it('keeps the two mechanisms separable for trade_pair_activity', async () => {
    // The reason trade_type is stored at all: an order-book fill and an
    // automated-market-maker swap on the same pair are different events, and #10 must
    // be able to group or separate them deliberately rather than summing them blind.
    const db = freshDb();
    await ingestTrades(adapt(db), client(), range());

    const nativeCetes = db
      .prepare(
        `SELECT trade_type, COUNT(*) n FROM trades
         WHERE base_asset_code = 'native' AND counter_asset_code = 'CETES'
         GROUP BY trade_type`,
      )
      .all() as { trade_type: string; n: number }[];

    // native/CETES occurs only via the pool in this range, which is exactly the kind
    // of distinction that would vanish if the column did not exist.
    assert.deepEqual(nativeCetes, [{ trade_type: 'liquidity_pool', n: 3 }]);
    db.close();
  });

  it('normalises native on either side to native with an empty issuer', async () => {
    const db = freshDb();
    await ingestTrades(adapt(db), client(), range());

    const nulls = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM trades
           WHERE base_asset_issuer IS NULL OR counter_asset_issuer IS NULL`,
        )
        .get() as { c: number }
    ).c;
    assert.equal(nulls, 0);

    const nativeRows = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM trades
           WHERE (base_asset_code = 'native' AND base_asset_issuer != '')
              OR (counter_asset_code = 'native' AND counter_asset_issuer != '')`,
        )
        .get() as { c: number }
    ).c;
    assert.equal(nativeRows, 0, 'native must always carry an empty issuer');
    db.close();
  });

  it('records the real asset pairs from testnet', async () => {
    const db = freshDb();
    await ingestTrades(adapt(db), client(), range());

    const codes = (
      db
        .prepare(
          `SELECT DISTINCT base_asset_code c FROM trades
           UNION SELECT DISTINCT counter_asset_code FROM trades ORDER BY c`,
        )
        .all() as { c: string }[]
    ).map((r) => r.c);

    assert.deepEqual(codes, ['CETES', 'SHOAM', 'USDC', 'native']);
    db.close();
  });

  it('stores amounts exactly as Horizon sent them', async () => {
    const db = freshDb();
    await ingestTrades(adapt(db), client(), range());

    const tradesPage = fixture.responses[
      `/trades?cursor=${((BigInt(fixture.fromLedger) << 32n) - 1n).toString()}&order=asc&limit=200`
    ] as {
      _embedded: {
        records: {
          id: string;
          paging_token: string;
          base_amount: string;
          counter_amount: string;
        }[];
      };
    };

    const expected = new Map(
      tradesPage._embedded.records
        .filter((t) => ledgerOf(t.paging_token) <= fixture.toLedger)
        .map((t) => [t.id, { base: t.base_amount, counter: t.counter_amount }]),
    );

    const stored = db.prepare('SELECT id, base_amount, counter_amount FROM trades').all() as {
      id: string;
      base_amount: string;
      counter_amount: string;
    }[];

    assert.equal(stored.length, 12);
    for (const row of stored) {
      const want = expected.get(row.id);
      assert.ok(want, `unexpected trade ${row.id}`);
      assert.equal(row.base_amount, want.base, `base_amount drift on ${row.id}`);
      assert.equal(row.counter_amount, want.counter, `counter_amount drift on ${row.id}`);
    }
    db.close();
  });

  it('is idempotent: re-ingesting the same range writes nothing', async () => {
    const db = freshDb();
    await ingestTrades(adapt(db), client(), range());
    const before = (db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c;

    const second = await ingestTrades(adapt(db), client(), range());

    assert.equal(second.tradesWritten, 0);
    assert.equal(second.ledgersWritten, 0);
    assert.equal(second.tradesSeen, 12, 'still sees them, just does not rewrite');
    assert.equal((db.prepare('SELECT COUNT(*) c FROM trades').get() as { c: number }).c, before);
    db.close();
  });

  it('writes ledger parents so the foreign key resolves', async () => {
    const db = freshDb();
    await ingestTrades(adapt(db), client(), range());

    assert.deepEqual(db.pragma('foreign_key_check'), []);

    const orphans = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM trades t
           LEFT JOIN ledgers l ON l.sequence = t.ledger_sequence WHERE l.sequence IS NULL`,
        )
        .get() as { c: number }
    ).c;
    assert.equal(orphans, 0);
    db.close();
  });

  it('stops at toLedger', async () => {
    const db = freshDb();
    const narrow = await ingestTrades(adapt(db), client(), {
      fromLedger: fixture.fromLedger,
      toLedger: fixture.fromLedger + 40,
    });
    assert.ok(narrow.tradesSeen < 12);
    assert.equal(narrow.ledgersWritten, 41);
    db.close();
  });

  it('rejects an inverted range', async () => {
    const db = freshDb();
    await assert.rejects(
      () => ingestTrades(adapt(db), client(), { fromLedger: 100, toLedger: 50 }),
      RangeError,
    );
    db.close();
  });
});

describe('trade type handling', () => {
  it('models exactly the two mechanisms Horizon reports', () => {
    assert.deepEqual([...TRADE_TYPES].sort(), ['liquidity_pool', 'orderbook']);
  });

  it('skips an unmodelled trade_type instead of aborting the range', async () => {
    // A third mechanism would violate the CHECK constraint and kill the whole run.
    // Skipping and counting surfaces it while keeping the rest of the range, and a
    // non-zero skippedUnknownType is the signal to add support.
    type TradesPage = { _embedded: { records: { trade_type?: string }[] } };

    const tradesKey = `/trades?cursor=${((BigInt(fixture.fromLedger) << 32n) - 1n).toString()}&order=asc&limit=200`;

    const mutated = structuredClone(fixture) as typeof fixture & {
      responses: Record<string, unknown>;
    };
    const mutatedPage = mutated.responses[tradesKey] as TradesPage;
    // Relabel one recorded trade as a mechanism this version does not know about.
    const first = mutatedPage._embedded.records[0];
    assert.ok(first);
    first.trade_type = 'some_future_mechanism';

    const altServer = await startFixtureServer(mutated);
    try {
      const db = freshDb();
      const result = await ingestTrades(
        adapt(db),
        new HorizonClient({ baseUrl: altServer.baseUrl }),
        range(),
      );

      assert.equal(result.skippedUnknownType, 1);
      assert.equal(result.tradesSeen, 11, 'the other 11 still ingest');
      assert.equal(result.tradesWritten, 11);
      db.close();
    } finally {
      await altServer.close();
    }
  });
});

describe('trades fixture provenance', () => {
  it('is a trades capture from testnet', () => {
    assert.equal(fixture.job, 'trades');
    assert.equal(fixture.networkPassphrase, 'Test SDF Network ; September 2015');
    assert.ok(!Number.isNaN(Date.parse(fixture.capturedAt)));
  });
});
