import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { runCli } from '../src/cli.ts';
import { migratePostgres } from '../src/db/postgres.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from './helpers/fixture-server.ts';

/**
 * `ingest` and `poll` driven against a real Postgres through the CLI (issue #73).
 *
 * The end of the chain #67 and #72 built: argument parsing, the engine branch,
 * the adapter, the jobs and the watermark, exercised together the way an
 * operator would. Everything below `runCli` is the shipped code path — no
 * adapter is constructed by hand here.
 *
 * Skips without DATABASE_URL, like the other Postgres suites. Its own file
 * rather than a skipped block inside cli.test.ts so the `postgres` CI job can
 * run it without also re-running the SQLite CLI cases.
 *
 * Unlike test/postgres.test.ts this uses the default schema, because the CLI
 * builds its own connection from the flag and there is nowhere to inject a
 * search_path. Tables are truncated per test instead.
 */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'DATABASE_URL is not set (no Postgres available)';

const fixture = loadFixture('testnet-payments-4539850-4539862');

/**
 * The fixture plus a chain head.
 *
 * `poll` asks Horizon where the head is before deciding what to ingest, and the
 * recorded fixtures are ranges rather than live endpoints, so `/ledgers?order=desc`
 * was never captured. Reporting the range's own last ledger as the head — with
 * `--confirmation-lag 0` — makes the pass cover exactly the recorded range, so
 * the cursors the job asks for are the ones on disk.
 */
const HEAD = fixture.toLedger;
const fixtureWithHead = {
  ...fixture,
  responses: {
    ...fixture.responses,
    '/ledgers?order=desc&limit=1': {
      _embedded: {
        records: [
          {
            sequence: HEAD,
            paging_token: String(HEAD),
            closed_at: '2026-01-01T00:00:00Z',
            operation_count: 0,
          },
        ],
      },
    },
  },
};

type Client = import('pg').Client;
let client: Client | undefined;
let server: FixtureServer;

before(async () => {
  server = await startFixtureServer(fixtureWithHead);
  if (!DATABASE_URL) return;
  const { Client: PgClient } = await import('pg');
  client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
  await migratePostgres(client);
});

after(async () => {
  await server.close();
  if (client) await client.end();
});

beforeEach(async () => {
  if (!client) return;
  // CASCADE because the ingestion tables are joined by foreign keys, and this
  // has to leave the schema in place -- the CLI is expected to find it migrated
  // or migrate it itself, not to be handed an empty database.
  await client.query(
    `TRUNCATE ledgers, accounts, operations, payments, trades, trustlines, ingest_state CASCADE`,
  );
});

function db(): Client {
  if (!client) throw new Error('Postgres client not initialised');
  return client;
}

async function countOf(table: string): Promise<number> {
  const result = await db().query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return (result.rows[0] as { c: number }).c;
}

async function watermarkOf(job: string): Promise<number | undefined> {
  const result = await db().query('SELECT last_ledger FROM ingest_state WHERE job = $1', [job]);
  const row = result.rows[0] as { last_ledger: number } | undefined;
  return row ? Number(row.last_ledger) : undefined;
}

describe('ingest --postgres', { skip }, () => {
  it('ingests a ledger range into Postgres', async () => {
    const code = await runCli([
      'ingest',
      '--from',
      String(fixture.fromLedger),
      '--to',
      String(fixture.toLedger),
      '--postgres',
      DATABASE_URL!,
      '--horizon',
      server.baseUrl,
      '--payments',
    ]);

    assert.equal(code, 0);
    // The same eight payments the SQLite CLI test asserts on the same fixture,
    // which is the point: one job, one range, either engine.
    assert.equal(await countOf('payments'), 8);
    assert.equal(await countOf('ledgers'), 13);
  });

  it('is idempotent when run twice', async () => {
    const args = [
      'ingest',
      '--from',
      String(fixture.fromLedger),
      '--to',
      String(fixture.toLedger),
      '--postgres',
      DATABASE_URL!,
      '--horizon',
      server.baseUrl,
      '--payments',
    ];

    assert.equal(await runCli(args), 0);
    assert.equal(await runCli(args), 0);
    assert.equal(await countOf('payments'), 8, 'the second run must add nothing');
  });

  it('migrates on start against an unmigrated database', async () => {
    // Migrate-on-start picking the Postgres runner rather than the SQLite one.
    // Dropping the tables is the only way to prove it ran; the suite's own
    // `before` would otherwise have left them in place.
    await db().query(
      `DROP TABLE IF EXISTS payments, operations, trades, trustlines, accounts, ledgers,
       ingest_state, anchor_issuers, schema_migrations CASCADE`,
    );
    await db().query(
      `DROP VIEW IF EXISTS account_flow_daily, asset_velocity, anchor_payment_volume,
       trade_pair_activity, top_accounts_by_volume CASCADE`,
    );

    const code = await runCli([
      'ingest',
      '--from',
      String(fixture.fromLedger),
      '--to',
      String(fixture.toLedger),
      '--postgres',
      DATABASE_URL!,
      '--horizon',
      server.baseUrl,
      '--payments',
    ]);

    assert.equal(code, 0);
    assert.equal(await countOf('payments'), 8);
  });

  it('reports a connection failure as a non-zero exit rather than a crash', async () => {
    const code = await runCli([
      'ingest',
      '--from',
      '1',
      '--to',
      '2',
      '--postgres',
      'postgres://user:pw@127.0.0.1:1/nope',
      '--horizon',
      server.baseUrl,
    ]);

    assert.equal(code, 1);
  });
});

describe('poll --postgres', { skip }, () => {
  it('runs a single tick and records the watermark', async () => {
    const code = await runCli([
      'poll',
      '--postgres',
      DATABASE_URL!,
      '--horizon',
      server.baseUrl,
      '--jobs',
      'payments',
      '--start-ledger',
      String(fixture.fromLedger),
      '--confirmation-lag',
      '0',
      '--once',
    ]);

    assert.equal(code, 0);
    assert.equal(await countOf('payments'), 8);
    assert.equal(await watermarkOf('payments'), HEAD, 'the watermark must have advanced');
  });

  it('resumes from the recorded watermark rather than re-reading the range', async () => {
    // A second tick has nothing left to do, because the watermark is already at
    // the head the fixture reports. The pass is a no-op and the watermark holds.
    const args = [
      'poll',
      '--postgres',
      DATABASE_URL!,
      '--horizon',
      server.baseUrl,
      '--jobs',
      'payments',
      '--start-ledger',
      String(fixture.fromLedger),
      '--confirmation-lag',
      '0',
      '--once',
    ];

    assert.equal(await runCli(args), 0);
    assert.equal(await runCli(args), 0);

    assert.equal(await watermarkOf('payments'), HEAD);
    assert.equal(await countOf('payments'), 8);
  });
});
