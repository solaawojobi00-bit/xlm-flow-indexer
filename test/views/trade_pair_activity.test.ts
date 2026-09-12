import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { ingestTrades } from '../../src/ingest/trades.ts';
import { adapt } from '../helpers/adapter.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

const FIXTURE_NAME = 'testnet-trades-4534150-4534300';
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

interface TradePairActivityRow {
  asset_a_code: string;
  asset_a_issuer: string;
  asset_b_code: string;
  asset_b_issuer: string;
  day: string;
  trade_count: number;
  asset_a_volume: number;
  asset_b_volume: number;
  orderbook_trades_count: number;
  liquidity_pool_trades_count: number;
}

describe('trade_pair_activity view', () => {
  it('is created by migration and present after fresh migrate', () => {
    const db = freshDb();
    const views = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'trade_pair_activity'`,
      )
      .all();
    assert.equal(views.length, 1);
  });

  it('aggregates trade pair activity correctly against recorded testnet data', async () => {
    const db = freshDb();
    await ingestTrades(adapt(db), client(), range());

    const rows = db
      .prepare(
        `SELECT * FROM trade_pair_activity
         ORDER BY asset_a_code, asset_a_issuer, asset_b_code, asset_b_issuer, day`,
      )
      .all() as TradePairActivityRow[];

    assert.ok(rows.length > 0, 'must return trade pair rows');

    // Total trades across all pairs must equal 12 (the fixture count)
    const totalTrades = rows.reduce((sum, r) => sum + r.trade_count, 0);
    assert.equal(totalTrades, 12);

    const totalOrderbook = rows.reduce((sum, r) => sum + r.orderbook_trades_count, 0);
    const totalPool = rows.reduce((sum, r) => sum + r.liquidity_pool_trades_count, 0);
    assert.equal(totalOrderbook, 9);
    assert.equal(totalPool, 3);

    // Verify native encoding on legs
    for (const r of rows) {
      if (r.asset_a_code === 'native') {
        assert.equal(r.asset_a_issuer, '');
      }
      if (r.asset_b_code === 'native') {
        assert.equal(r.asset_b_issuer, '');
      }
      assert.equal(
        r.trade_count,
        r.orderbook_trades_count + r.liquidity_pool_trades_count,
        'trade_count must equal sum of trade types',
      );
    }
  });

  it('separates assets sharing the same code from different issuers into distinct rows', () => {
    const db = freshDb();
    const issuer1 = 'GA_ISSUER_ONE_TEST';
    const issuer2 = 'GB_ISSUER_TWO_TEST';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      100,
      '2026-09-04T12:00:00Z',
      2,
    );

    // Trade 1: native / USDC (issuer 1)
    db.prepare(
      `INSERT INTO trades (id, ledger_sequence, base_asset_code, base_asset_issuer, counter_asset_code, counter_asset_issuer, base_amount, counter_amount, executed_at, trade_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't1',
      100,
      'USDC',
      issuer1,
      'native',
      '',
      '100.0000000',
      '500.0000000',
      '2026-09-04T10:00:00Z',
      'orderbook',
    );

    // Trade 2: native / USDC (issuer 2)
    db.prepare(
      `INSERT INTO trades (id, ledger_sequence, base_asset_code, base_asset_issuer, counter_asset_code, counter_asset_issuer, base_amount, counter_amount, executed_at, trade_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't2',
      100,
      'USDC',
      issuer2,
      'native',
      '',
      '200.0000000',
      '1000.0000000',
      '2026-09-04T11:00:00Z',
      'orderbook',
    );

    const rows = db
      .prepare(`SELECT * FROM trade_pair_activity ORDER BY asset_a_issuer, asset_b_issuer`)
      .all() as TradePairActivityRow[];

    assert.equal(
      rows.length,
      2,
      'different issuers with same asset code must produce 2 distinct rows',
    );
    const row1 = rows[0]!;
    const row2 = rows[1]!;

    assert.notEqual(
      row1.asset_a_issuer || row1.asset_b_issuer,
      row2.asset_a_issuer || row2.asset_b_issuer,
    );
  });

  it('normalises pair direction so inverse trade legs combine into a single unified market', () => {
    const db = freshDb();
    const usdcIssuer = 'G_USDC_ISSUER';

    db.prepare('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)').run(
      200,
      '2026-09-04T12:00:00Z',
      2,
    );

    // Trade 1: USDC base, native counter
    db.prepare(
      `INSERT INTO trades (id, ledger_sequence, base_asset_code, base_asset_issuer, counter_asset_code, counter_asset_issuer, base_amount, counter_amount, executed_at, trade_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't_dir1',
      200,
      'USDC',
      usdcIssuer,
      'native',
      '',
      '10.0000000',
      '50.0000000',
      '2026-09-04T12:00:00Z',
      'orderbook',
    );

    // Trade 2: native base, USDC counter (inverse direction)
    db.prepare(
      `INSERT INTO trades (id, ledger_sequence, base_asset_code, base_asset_issuer, counter_asset_code, counter_asset_issuer, base_amount, counter_amount, executed_at, trade_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      't_dir2',
      200,
      'native',
      '',
      'USDC',
      usdcIssuer,
      '70.0000000',
      '15.0000000',
      '2026-09-04T13:00:00Z',
      'liquidity_pool',
    );

    const rows = db.prepare(`SELECT * FROM trade_pair_activity`).all() as TradePairActivityRow[];

    assert.equal(rows.length, 1, 'inverse directions must consolidate into a single pair row');
    const market = rows[0]!;
    assert.equal(market.trade_count, 2);
    assert.equal(market.orderbook_trades_count, 1);
    assert.equal(market.liquidity_pool_trades_count, 1);

    // Check volumes routed correctly to the normalized asset positions
    if (market.asset_a_code === 'USDC') {
      assert.equal(market.asset_a_volume, 25.0); // 10 + 15
      assert.equal(market.asset_b_volume, 120.0); // 50 + 70
    } else {
      assert.equal(market.asset_a_volume, 120.0);
      assert.equal(market.asset_b_volume, 25.0);
    }
  });
});
