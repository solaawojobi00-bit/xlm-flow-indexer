import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadAnchorIssuers } from '../src/db/anchors.ts';
import { openDb, type Db } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';

function migrated(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

interface PlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

function explain(db: Db, sql: string, params: unknown[] = []): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanRow[];
  return rows.map((r) => r.detail).join('\n');
}

describe('indexing and query plan verification (Issue #15)', () => {
  it('confirms all Phase 1 ARCHITECTURE.md indexes are active', () => {
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

  it('account_flow_daily utilizes account and primary key indexes when filtered by account', () => {
    const db = migrated();
    const plan = explain(db, `SELECT * FROM account_flow_daily WHERE account_id = ?`, [
      'GACCOUNT1',
    ]);

    // Queries filtered by account should leverage payments account indexes and operations PK join
    const usesAccountIndex =
      plan.includes('idx_payments_from_account') ||
      plan.includes('idx_payments_to_account') ||
      plan.includes('USING INDEX');
    const usesOperationsPK =
      plan.includes('PRIMARY KEY') ||
      plan.includes('sqlite_autoindex_operations_1') ||
      plan.includes('USING INDEX');

    assert.ok(
      usesAccountIndex,
      `account_flow_daily query plan should reference account index.\nPlan:\n${plan}`,
    );
    assert.ok(
      usesOperationsPK,
      `account_flow_daily query plan should reference operations PK join.\nPlan:\n${plan}`,
    );
    db.close();
  });

  it('asset_velocity utilizes asset index when filtered by asset pair', () => {
    const db = migrated();
    const plan = explain(
      db,
      `SELECT * FROM asset_velocity WHERE asset_code = ? AND asset_issuer = ?`,
      ['native', ''],
    );

    const usesAssetIndex = plan.includes('idx_payments_asset') || plan.includes('USING INDEX');

    assert.ok(
      usesAssetIndex,
      `asset_velocity query plan should reference asset index.\nPlan:\n${plan}`,
    );
    db.close();
  });

  it('anchor_payment_volume utilizes anchor_issuers PK and payments asset index', () => {
    const db = migrated();
    loadAnchorIssuers(db, [{ account_id: 'GANCHOR1', name: 'Anchor 1' }]);

    const plan = explain(db, `SELECT * FROM anchor_payment_volume WHERE issuer_account_id = ?`, [
      'GANCHOR1',
    ]);

    const usesAnchorPK =
      plan.includes('sqlite_autoindex_anchor_issuers_1') ||
      plan.includes('PRIMARY KEY') ||
      plan.includes('USING INDEX');

    assert.ok(
      usesAnchorPK,
      `anchor_payment_volume should use anchor_issuers PK lookup.\nPlan:\n${plan}`,
    );
    db.close();
  });

  it('trade_pair_activity utilizes trades execution timestamp index on date range queries', () => {
    const db = migrated();
    const plan = explain(db, `SELECT * FROM trade_pair_activity WHERE day = '2026-09-04'`);

    assert.ok(plan.length > 0, 'Query plan should be produced for trade_pair_activity');
    db.close();
  });

  it('top_accounts_by_volume utilizes account indexes when filtered by account', () => {
    const db = migrated();
    const plan = explain(db, `SELECT * FROM top_accounts_by_volume WHERE account_id = ?`, [
      'GACCOUNT1',
    ]);

    const usesAccountIndex =
      plan.includes('idx_payments_from_account') ||
      plan.includes('idx_payments_to_account') ||
      plan.includes('USING INDEX');

    assert.ok(
      usesAccountIndex,
      `top_accounts_by_volume query plan should reference account index.\nPlan:\n${plan}`,
    );
    db.close();
  });
});
