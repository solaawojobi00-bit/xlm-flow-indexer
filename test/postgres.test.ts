import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { migratePostgres, appliedPostgresMigrations } from '../src/db/postgres.ts';

/**
 * Postgres migration suite (issue #48).
 *
 * Runs only when DATABASE_URL points at a real Postgres. There is no embedded
 * Postgres equivalent of `:memory:` SQLite, and stubbing the server would
 * verify nothing that matters here — the whole question is whether Postgres
 * accepts the translated DDL and enforces the constraints. So without a server
 * these skip rather than pretend.
 *
 * CI provides the server: the `postgres` job in ci.yml runs a service
 * container and sets DATABASE_URL. Locally they are skipped, which is why the
 * dialect-level assertions in dialect.test.ts exist — those run everywhere and
 * cover the rendering, while these cover the engine's actual behaviour.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'DATABASE_URL is not set (no Postgres available)';

/** A dedicated schema, so the suite cannot collide with anything else. */
const SCHEMA = 'xlm_flow_indexer_test';

type Client = import('pg').Client;
let client: Client | undefined;

before(async () => {
  if (!DATABASE_URL) return;
  const { Client: PgClient } = await import('pg');
  client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
});

after(async () => {
  if (client) {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  }
});

beforeEach(async () => {
  if (!client) return;
  // A fresh schema per test. The migrations create unqualified relations, so
  // pointing search_path at an empty schema is the Postgres analogue of the
  // fresh `:memory:` database the SQLite suites use.
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
});

/** Narrowing helper: inside a non-skipped test the client is always present. */
function db(): Client {
  if (!client) throw new Error('Postgres client not initialised');
  return client;
}

async function rows<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> {
  const result = await db().query(sql, values);
  return result.rows as T[];
}

describe('migrations apply to Postgres', { skip }, () => {
  it('applies every migration from an empty schema', async () => {
    assert.deepEqual(await migratePostgres(db()), [1, 2, 3, 4, 5, 6, 7]);

    const applied = await appliedPostgresMigrations(db());
    assert.deepEqual(
      applied.map((m) => m.version),
      [1, 2, 3, 4, 5, 6, 7],
    );
    // applied_at is TIMESTAMPTZ here and TEXT in SQLite; both are normalised to
    // an ISO8601 string so the two engines' records compare like with like.
    for (const record of applied) {
      assert.match(record.applied_at, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('is a no-op on a second run', async () => {
    await migratePostgres(db());
    assert.deepEqual(await migratePostgres(db()), [], 'second run must apply nothing');
    assert.equal((await appliedPostgresMigrations(db())).length, 7);
  });

  it('creates every table and view', async () => {
    await migratePostgres(db());

    const tables = (
      await rows<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
        [SCHEMA],
      )
    ).map((r) => r.table_name);

    assert.deepEqual(tables, [
      'accounts',
      'anchor_issuers',
      'ledgers',
      'operations',
      'payments',
      'schema_migrations',
      'trades',
      'trustlines',
    ]);

    const views = (
      await rows<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views
         WHERE table_schema = $1 ORDER BY table_name`,
        [SCHEMA],
      )
    ).map((r) => r.table_name);

    assert.deepEqual(views, [
      'account_flow_daily',
      'anchor_payment_volume',
      'asset_velocity',
      'top_accounts_by_volume',
      'trade_pair_activity',
    ]);
  });

  it('makes every view queryable', async () => {
    // The migration only has to parse for CREATE VIEW to succeed; a view whose
    // body is invalid at execution time still gets created. Selecting from each
    // one is what proves the translated SQL actually runs.
    await migratePostgres(db());

    for (const view of [
      'account_flow_daily',
      'asset_velocity',
      'anchor_payment_volume',
      'trade_pair_activity',
      'top_accounts_by_volume',
    ]) {
      const result = await rows<{ count: string }>(`SELECT COUNT(*) AS count FROM ${view}`);
      assert.equal(result[0]?.count, '0', `${view} must be queryable and empty`);
    }
  });
});

describe('translated column types', { skip }, () => {
  async function columnType(table: string, column: string): Promise<Record<string, unknown>> {
    const result = await rows(
      `SELECT data_type, numeric_precision, numeric_scale, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [SCHEMA, table, column],
    );
    assert.ok(result[0], `${table}.${column} must exist`);
    return result[0];
  }

  it('stores amounts as NUMERIC(19, 7)', async () => {
    await migratePostgres(db());

    for (const [table, column] of [
      ['payments', 'amount'],
      ['trades', 'base_amount'],
      ['trades', 'counter_amount'],
    ] as const) {
      const info = await columnType(table, column);
      assert.equal(info.data_type, 'numeric', `${table}.${column}`);
      assert.equal(info.numeric_precision, 19, `${table}.${column} precision`);
      assert.equal(info.numeric_scale, 7, `${table}.${column} scale`);
    }
  });

  it('stores timestamps as TIMESTAMPTZ', async () => {
    await migratePostgres(db());

    for (const [table, column] of [
      ['ledgers', 'closed_at'],
      ['operations', 'created_at'],
      ['trustlines', 'established_at'],
      ['trades', 'executed_at'],
    ] as const) {
      assert.equal(
        (await columnType(table, column)).data_type,
        'timestamp with time zone',
        `${table}.${column}`,
      );
    }
  });

  it('holds the largest Stellar amount without loss', async () => {
    // This is the point of the translation. A Stellar amount is an int64 stroop
    // count at 1e-7, so 922337203685.4775807 is the maximum, and it needs all
    // 19 significant digits. Stored as REAL -- or read through a float -- the
    // trailing digits are gone.
    await migratePostgres(db());
    await seedOnePayment('922337203685.4775807');

    const [row] = await rows<{ amount: string }>('SELECT amount FROM payments');
    assert.equal(row?.amount, '922337203685.4775807');
  });

  it('keeps amounts exact through view aggregation', async () => {
    await migratePostgres(db());
    await seedOnePayment('0.0000001');

    const [row] = await rows<{ outbound: string }>(
      `SELECT outbound FROM account_flow_daily WHERE account_id = 'GFROM'`,
    );
    // A single stroop. Through SUM() over NUMERIC this is exact; through a
    // float cast it would not be.
    assert.equal(row?.outbound, '0.0000001');
  });

  async function seedOnePayment(amount: string): Promise<void> {
    await db().query(
      `INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (1, '2026-01-01T00:00:00Z', 1)`,
    );
    await db().query(`INSERT INTO accounts (account_id) VALUES ('GFROM'), ('GTO')`);
    await db().query(
      `INSERT INTO operations (id, ledger_sequence, type, source_account, created_at)
       VALUES ('op1', 1, 'payment', 'GFROM', '2026-01-01T00:00:00Z')`,
    );
    await db().query(
      `INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount)
       VALUES ('op1', 'GFROM', 'GTO', 'native', '', $1)`,
      [amount],
    );
  }
});

describe('the #1 schema amendments hold in Postgres', { skip }, () => {
  it('rejects a duplicate native trustline', async () => {
    // The regression from issue #1, re-verified against the engine rather than
    // the DDL text. In SQLite the empty-string issuer is what makes this
    // collide, because a NULL would not. Postgres implies NOT NULL on primary
    // key columns, so here the explicit NOT NULL is redundant -- but the
    // primary key must still span asset_issuer for this to fail.
    await migratePostgres(db());
    await db().query(`INSERT INTO accounts (account_id) VALUES ('GTEST')`);

    const insert = `INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at)
                    VALUES ('GTEST', 'USDC', '', $1)`;
    await db().query(insert, ['2026-01-01T00:00:00Z']);

    await assert.rejects(
      () => db().query(insert, ['2026-06-01T00:00:00Z']),
      /duplicate key value violates unique constraint/,
    );

    const [row] = await rows<{ count: string }>('SELECT COUNT(*) AS count FROM trustlines');
    assert.equal(row?.count, '1');
  });

  it('rejects a NULL issuer outright', async () => {
    await migratePostgres(db());
    await db().query(`INSERT INTO accounts (account_id) VALUES ('GTEST')`);

    await assert.rejects(
      () =>
        db().query(
          `INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at)
           VALUES ('GTEST', 'USDC', NULL, '2026-01-01T00:00:00Z')`,
        ),
      /null value in column "asset_issuer"|violates not-null constraint/,
    );
  });

  it('defaults asset_issuer to the empty string', async () => {
    await migratePostgres(db());
    await db().query(`INSERT INTO accounts (account_id) VALUES ('GTEST')`);
    await db().query(
      `INSERT INTO trustlines (account_id, asset_code, established_at)
       VALUES ('GTEST', 'USDC', '2026-01-01T00:00:00Z')`,
    );

    const [row] = await rows<{ asset_issuer: string }>('SELECT asset_issuer FROM trustlines');
    assert.equal(row?.asset_issuer, '');
  });

  it('spans asset_issuer in the trustlines primary key', async () => {
    await migratePostgres(db());

    const columns = (
      await rows<{ column_name: string }>(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = 'trustlines'
           AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position`,
        [SCHEMA],
      )
    ).map((r) => r.column_name);

    assert.deepEqual(columns, ['account_id', 'asset_code', 'asset_issuer']);
  });

  it('carries both issuer columns on trades', async () => {
    await migratePostgres(db());

    const columns = (
      await rows<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'trades' AND column_name LIKE '%asset_issuer'
         ORDER BY column_name`,
        [SCHEMA],
      )
    ).map((r) => r.column_name);

    assert.deepEqual(columns, ['base_asset_issuer', 'counter_asset_issuer']);
  });
});

describe('checksum enforcement in Postgres', { skip }, () => {
  it('refuses to run when an applied migration has changed', async () => {
    await migratePostgres(db());

    // Simulate the repo and the database disagreeing about migration 3.
    await db().query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 3`);

    await assert.rejects(
      () => migratePostgres(db()),
      /Migration 3_account_flow_daily\.sql has changed since it was applied/,
    );
  });
});
