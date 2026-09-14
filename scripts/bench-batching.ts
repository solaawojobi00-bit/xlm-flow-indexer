/**
 * Measure what bounded write batching costs and saves (issue #68).
 *
 * The claim batching is adopted on is that a commit is a durability barrier the
 * server must flush before it answers, so the price of ingestion against Postgres
 * is paid per commit rather than per row. That claim is only worth acting on if it
 * is measured, which is the fourth acceptance criterion on #68 — and it cannot be
 * measured by the test suite, because the suite runs against in-memory SQLite where
 * a commit costs almost nothing.
 *
 * ---------------------------------------------------------------------------
 * How the baseline is obtained
 * ---------------------------------------------------------------------------
 * The "unbatched" arm is not a reimplementation of the pre-#68 jobs. It is the
 * *current* job code driven through an adapter whose `transaction()` runs the
 * callback without issuing BEGIN or COMMIT, so every statement inside autocommits
 * on its own — which is exactly what the jobs did before. Reproducing the old write
 * pattern rather than the old source keeps the two arms honest: they differ in
 * where the commits fall and in nothing else.
 *
 * ---------------------------------------------------------------------------
 * Running it
 * ---------------------------------------------------------------------------
 *   node scripts/bench-batching.ts                        # SQLite, temp file
 *   node scripts/bench-batching.ts --postgres "$DATABASE_URL"
 *
 * The Postgres run is the one that answers the acceptance criterion; the SQLite run
 * is a sanity check that costs nothing and needs no server. Both replay the recorded
 * fixtures over a local HTTP server, so Horizon latency is absent from both arms and
 * the difference reported is the database's.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunResult, SqlAdapter, SqlParam } from '../src/db/adapter.ts';
import { openDb } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { pgAdapter } from '../src/db/pg-adapter.ts';
import { migratePostgres } from '../src/db/postgres.ts';
import { sqliteAdapter } from '../src/db/sqlite-adapter.ts';
import { HorizonClient } from '../src/horizon/client.ts';
import { DEFAULT_BATCH_RECORDS } from '../src/ingest/batch.ts';
import { ingestPayments, type LedgerRange } from '../src/ingest/payments.ts';
import { ingestTrades } from '../src/ingest/trades.ts';
import { ingestTrustlines } from '../src/ingest/trustlines.ts';
import {
  loadFixture,
  startFixtureServer,
  type Fixture,
  type FixtureServer,
} from '../test/helpers/fixture-server.ts';

/**
 * The arms measured, in the order reported.
 *
 * `undefined` is the unbatched baseline. The rest are batch sizes, chosen to show
 * the shape of the curve rather than to argue for one of them: 1 isolates "a commit
 * per record" from "a commit per statement", and the default is the value shipped.
 */
const ARMS: readonly (number | undefined)[] = [undefined, 1, 25, DEFAULT_BATCH_RECORDS];

interface Measurement {
  readonly arm: string;
  readonly commits: number;
  readonly statements: number;
  readonly millis: number;
  readonly rows: number;
}

/**
 * Counts commits and statements, and optionally suppresses the transaction itself.
 *
 * `autocommit` is what makes the baseline arm possible: the job still calls
 * `transaction()`, but the wrapper runs the callback directly against the connection
 * so nothing groups the statements inside it.
 */
function instrument(
  target: SqlAdapter,
  autocommit: boolean,
): { adapter: SqlAdapter; commits: () => number; statements: () => number } {
  let commits = 0;
  let statements = 0;

  const adapter: SqlAdapter = {
    dialect: target.dialect,

    run(sql: string, params?: readonly SqlParam[]): Promise<RunResult> {
      statements += 1;
      // Without a surrounding transaction every statement is its own commit, which
      // is the cost the baseline exists to expose.
      if (autocommit) commits += 1;
      return target.run(sql, params);
    },

    get<T>(sql: string, params?: readonly SqlParam[]): Promise<T | undefined> {
      return target.get<T>(sql, params);
    },

    all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]> {
      return target.all<T>(sql, params);
    },

    transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
      if (autocommit) return fn(adapter);
      commits += 1;
      return target.transaction(() => fn(adapter));
    },

    close(): Promise<void> {
      return target.close();
    },
  };

  return { adapter, commits: () => commits, statements: () => statements };
}

interface Workload {
  readonly payments: { server: FixtureServer; range: LedgerRange };
  readonly trustlines: { server: FixtureServer; range: LedgerRange };
  readonly trades: { server: FixtureServer; range: LedgerRange };
}

function rangeOf(fixture: Fixture): LedgerRange {
  return { fromLedger: fixture.fromLedger, toLedger: fixture.toLedger };
}

async function startWorkload(): Promise<{ workload: Workload; close: () => Promise<void> }> {
  const fixtures = {
    payments: loadFixture('testnet-payments-4539840-4539872'),
    trustlines: loadFixture('testnet-trustlines-4540630-4540680'),
    trades: loadFixture('testnet-trades-4534150-4534300'),
  };

  const [payments, trustlines, trades] = await Promise.all([
    startFixtureServer(fixtures.payments),
    startFixtureServer(fixtures.trustlines),
    startFixtureServer(fixtures.trades),
  ]);

  return {
    workload: {
      payments: { server: payments, range: rangeOf(fixtures.payments) },
      trustlines: { server: trustlines, range: rangeOf(fixtures.trustlines) },
      trades: { server: trades, range: rangeOf(fixtures.trades) },
    },
    close: async () => {
      await Promise.all([payments.close(), trustlines.close(), trades.close()]);
    },
  };
}

function clientFor(server: FixtureServer): HorizonClient {
  return new HorizonClient({ baseUrl: server.baseUrl });
}

/** One full pass of all three jobs, returning the rows they reported writing. */
async function runWorkload(
  sql: SqlAdapter,
  workload: Workload,
  batchSize: number | undefined,
): Promise<number> {
  const options = batchSize === undefined ? undefined : { batchSize };

  const payments = await ingestPayments(
    sql,
    clientFor(workload.payments.server),
    workload.payments.range,
    options,
  );
  const trustlines = await ingestTrustlines(
    sql,
    clientFor(workload.trustlines.server),
    workload.trustlines.range,
    options,
  );
  const trades = await ingestTrades(
    sql,
    clientFor(workload.trades.server),
    workload.trades.range,
    options,
  );

  return (
    payments.ledgersWritten +
    payments.accountsWritten +
    payments.operationsWritten +
    payments.paymentsWritten +
    trustlines.accountsWritten +
    trustlines.trustlinesWritten +
    trades.ledgersWritten +
    trades.tradesWritten
  );
}

/** A freshly migrated database and the adapter over it, one per arm. */
interface Arena {
  readonly sql: SqlAdapter;
  close(): Promise<void>;
}

function sqliteArena(dir: string, arm: number): Arena {
  // A file rather than :memory:, so the commits being counted are real ones that
  // reach a filesystem. An in-memory database would make every arm look free.
  const db = openDb(join(dir, `bench-${String(arm)}.db`));
  migrate(db);
  const sql = sqliteAdapter(db, { closeHandle: true });
  return { sql, close: () => sql.close() };
}

/**
 * A dedicated schema per arm, dropped and recreated, mirroring test/postgres.test.ts.
 *
 * Isolating by schema rather than by database keeps this runnable against whatever
 * server `DATABASE_URL` points at, including the CI service container, without
 * needing rights to create databases.
 */
const BENCH_SCHEMA = 'xlm_flow_indexer_bench';

async function postgresArena(connectionString: string): Promise<Arena> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();

  await client.query(`DROP SCHEMA IF EXISTS ${BENCH_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${BENCH_SCHEMA}`);
  await client.query(`SET search_path TO ${BENCH_SCHEMA}`);
  await migratePostgres(client);

  const sql = pgAdapter(client, { closeConnection: true });
  return { sql, close: () => sql.close() };
}

/** Leave the server as it was found — the last arm's schema outlives its connection. */
async function dropBenchSchema(connectionString: string): Promise<void> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${BENCH_SCHEMA} CASCADE`);
  } finally {
    await client.end();
  }
}

async function measure(
  workload: Workload,
  arena: () => Promise<Arena>,
  batchSize: number | undefined,
): Promise<Measurement> {
  const active = await arena();
  const autocommit = batchSize === undefined;
  const { adapter, commits, statements } = instrument(active.sql, autocommit);

  try {
    const started = performance.now();
    const rows = await runWorkload(adapter, workload, batchSize);
    const millis = performance.now() - started;

    return {
      arm: autocommit ? 'unbatched (pre-#68)' : `batchSize=${String(batchSize)}`,
      commits: commits(),
      statements: statements(),
      millis,
      rows,
    };
  } finally {
    await active.close();
  }
}

function report(engine: string, measurements: readonly Measurement[]): void {
  const baseline = measurements[0];
  if (baseline === undefined) return;

  console.log(`\n${engine}`);
  console.log('  arm                    commits  statements       ms   commits saved');
  console.log('  ---------------------  -------  ----------  -------  --------------');

  for (const m of measurements) {
    const saved =
      m === baseline
        ? '—'
        : `${(100 * (1 - m.commits / baseline.commits)).toFixed(1)}%`.padStart(14);
    console.log(
      `  ${m.arm.padEnd(21)}  ${String(m.commits).padStart(7)}  ${String(m.statements).padStart(10)}  ${m.millis.toFixed(0).padStart(7)}  ${saved}`,
    );
  }

  // Guards the benchmark against measuring nothing: every arm must ingest the same
  // data, or the commit counts are not comparable.
  const rows = new Set(measurements.map((m) => m.rows));
  if (rows.size !== 1) {
    throw new Error(`arms wrote different row counts (${[...rows].join(', ')}) — not comparable`);
  }
  console.log(`  every arm wrote ${String(baseline.rows)} rows.`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const pgFlag = args.indexOf('--postgres');
  const connectionString = pgFlag >= 0 ? args[pgFlag + 1] : undefined;

  if (pgFlag >= 0 && connectionString === undefined) {
    console.error('Error: --postgres requires a connection string');
    return 1;
  }

  const { workload, close } = await startWorkload();
  const dir = mkdtempSync(join(tmpdir(), 'xlm-bench-'));

  try {
    const measurements: Measurement[] = [];
    for (const [index, batchSize] of ARMS.entries()) {
      const arena =
        connectionString === undefined
          ? () => Promise.resolve(sqliteArena(dir, index))
          : () => postgresArena(connectionString);
      measurements.push(await measure(workload, arena, batchSize));
    }

    report(connectionString === undefined ? 'SQLite (file-backed)' : 'Postgres', measurements);
    return 0;
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
    if (connectionString !== undefined) await dropBenchSchema(connectionString);
  }
}

process.exitCode = await main();
