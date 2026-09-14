#!/usr/bin/env node
import { existsSync } from 'node:fs';

import type { SqlAdapter } from './db/adapter.ts';
import { loadAnchorIssuers } from './db/anchors.ts';
import { openDb } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { pgAdapter } from './db/pg-adapter.ts';
import { migratePostgres } from './db/postgres.ts';
import { sqliteAdapter } from './db/sqlite-adapter.ts';
import { HorizonClient } from './horizon/client.ts';
import { poll } from './ingest/incremental.ts';
import { ingestPayments } from './ingest/payments.ts';
import { allIngestState, type IngestJob } from './ingest/state.ts';
import { ingestTrades } from './ingest/trades.ts';
import { ingestTrustlines } from './ingest/trustlines.ts';

export const HELP_TEXT = `
xlm-flow-indexer - Horizon ledger ingestion and analytics indexer

Usage:
  xlm-flow-indexer <command> [options]

Commands:
  migrate                 Apply pending schema migrations to the database
  ingest                  Ingest transactions and effects across a ledger range
  poll                    Incrementally ingest new ledgers on an interval

Global Options:
  -h, --help              Show this help message
  -v, --version           Show version number

Command: migrate
  Options:
    --db <path>           Path to the SQLite database file (required unless --postgres)
    --postgres <url>      Apply to a Postgres database instead, e.g.
                          postgres://user:pass@host:5432/dbname
                          The same migration files are used for both engines;
                          amounts become NUMERIC and timestamps TIMESTAMPTZ.

Command: ingest
  Options:
    --from <sequence>     Starting ledger sequence (required, integer > 0)
    --to <sequence>       Ending ledger sequence (required, integer >= from)
    --db <path>           Path to the SQLite database file (required unless --postgres)
    --postgres <url>      Ingest into a Postgres database instead, e.g.
                          postgres://user:pass@host:5432/dbname
    --horizon <url>       Horizon base URL (default: https://horizon-testnet.stellar.org)
    --anchors <path>      Optional path to anchor issuers config JSON to populate
    --jobs <list>         Comma-separated list of jobs: payments,trustlines,trades (default: all)
    --payments            Run payments ingestion job
    --trustlines          Run trustlines ingestion job
    --trades              Run trades ingestion job

Command: poll
  Resumes each job from its own watermark in ingest_state, so only ledgers not
  yet processed are fetched. Stops short of the chain head by --confirmation-lag
  ledgers, because Horizon's own ingestion is asynchronous and the newest ledger
  it reports may not have all its operations queryable yet.

  To fill a gap, use the 'ingest' command over the explicit range -- see
  "Backfilling after a gap" in README.md. Backfill writes through the same
  statements and leaves the watermark untouched.

  Options:
    --db <path>           Path to the SQLite database file (required unless --postgres)
    --postgres <url>      Poll into a Postgres database instead, e.g.
                          postgres://user:pass@host:5432/dbname
    --interval <seconds>  Seconds between ticks (default: 30)
    --start-ledger <n>    Where to begin when a job has no watermark yet.
                          Required on a job's first run, so a first poll cannot
                          silently skip history.
    --once                Run a single tick and exit (useful for cron)
    --max-ticks <n>       Stop after n ticks
    --confirmation-lag <n>  Ledgers to stay behind the head (default: 5)
    --max-ledgers <n>     Most ledgers per pass (default: 200)
    --horizon <url>       Horizon base URL (default: https://horizon-testnet.stellar.org)
    --jobs <list>         Comma-separated: payments,trustlines,trades (default: all)

Examples:
  xlm-flow-indexer migrate --db ./indexer.db
  xlm-flow-indexer migrate --postgres postgres://localhost:5432/xlm
  xlm-flow-indexer ingest --from 4539850 --to 4539862 --db ./indexer.db
  xlm-flow-indexer ingest --from 4539850 --to 4539862 --db ./indexer.db --jobs payments,trades
  xlm-flow-indexer ingest --from 4539850 --to 4539862 --postgres postgres://localhost:5432/xlm
  xlm-flow-indexer poll --db ./indexer.db --start-ledger 4539850 --interval 30
  xlm-flow-indexer poll --db ./indexer.db --once
  xlm-flow-indexer poll --postgres postgres://localhost:5432/xlm --once
`;

export type IngestJobName = 'payments' | 'trustlines' | 'trades';

export interface ParsedArgs {
  command?: string | undefined;
  db?: string | undefined;
  postgres?: string | undefined;
  interval?: number | undefined;
  startLedger?: number | undefined;
  maxTicks?: number | undefined;
  confirmationLag?: number | undefined;
  maxLedgers?: number | undefined;
  once: boolean;
  from?: number | undefined;
  to?: number | undefined;
  horizon?: string | undefined;
  anchors?: string | undefined;
  jobs: IngestJobName[];
  help: boolean;
  version: boolean;
}

export function parseCliArgs(args: readonly string[]): ParsedArgs {
  let command: string | undefined;
  let db: string | undefined;
  let postgres: string | undefined;
  let interval: number | undefined;
  let startLedger: number | undefined;
  let maxTicks: number | undefined;
  let confirmationLag: number | undefined;
  let maxLedgers: number | undefined;
  let once = false;
  let from: number | undefined;
  let to: number | undefined;
  let horizon: string | undefined;
  let anchors: string | undefined;
  const specificJobs: IngestJobName[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--payments') {
      specificJobs.push('payments');
    } else if (arg === '--trustlines') {
      specificJobs.push('trustlines');
    } else if (arg === '--trades') {
      specificJobs.push('trades');
    } else if (arg === '--db') {
      db = args[++i];
    } else if (arg.startsWith('--db=')) {
      db = arg.slice(5);
    } else if (arg === '--postgres') {
      postgres = args[++i];
    } else if (arg.startsWith('--postgres=')) {
      postgres = arg.slice(11);
    } else if (arg === '--once') {
      once = true;
    } else if (arg === '--interval') {
      const val = args[++i];
      interval = val !== undefined ? Number(val) : NaN;
    } else if (arg.startsWith('--interval=')) {
      interval = Number(arg.slice(11));
    } else if (arg === '--start-ledger') {
      const val = args[++i];
      startLedger = val !== undefined ? Number(val) : NaN;
    } else if (arg.startsWith('--start-ledger=')) {
      startLedger = Number(arg.slice(15));
    } else if (arg === '--max-ticks') {
      const val = args[++i];
      maxTicks = val !== undefined ? Number(val) : NaN;
    } else if (arg.startsWith('--max-ticks=')) {
      maxTicks = Number(arg.slice(12));
    } else if (arg === '--confirmation-lag') {
      const val = args[++i];
      confirmationLag = val !== undefined ? Number(val) : NaN;
    } else if (arg.startsWith('--confirmation-lag=')) {
      confirmationLag = Number(arg.slice(19));
    } else if (arg === '--max-ledgers') {
      const val = args[++i];
      maxLedgers = val !== undefined ? Number(val) : NaN;
    } else if (arg.startsWith('--max-ledgers=')) {
      maxLedgers = Number(arg.slice(14));
    } else if (arg === '--from') {
      const val = args[++i];
      from = val !== undefined ? Number(val) : NaN;
    } else if (arg.startsWith('--from=')) {
      from = Number(arg.slice(7));
    } else if (arg === '--to') {
      const val = args[++i];
      to = val !== undefined ? Number(val) : NaN;
    } else if (arg.startsWith('--to=')) {
      to = Number(arg.slice(5));
    } else if (arg === '--horizon') {
      horizon = args[++i];
    } else if (arg.startsWith('--horizon=')) {
      horizon = arg.slice(10);
    } else if (arg === '--anchors') {
      anchors = args[++i];
    } else if (arg.startsWith('--anchors=')) {
      anchors = arg.slice(10);
    } else if (arg === '--jobs') {
      const list = args[++i];
      if (list) {
        for (const j of list.split(',')) {
          const trimmed = j.trim() as IngestJobName;
          if (trimmed === 'payments' || trimmed === 'trustlines' || trimmed === 'trades') {
            specificJobs.push(trimmed);
          } else {
            throw new Error(`Unknown job "${j}". Valid jobs: payments, trustlines, trades`);
          }
        }
      }
    } else if (!arg.startsWith('-')) {
      if (!command) {
        command = arg;
      } else if (!db) {
        // Allow positional db path
        db = arg;
      }
    }
  }

  const jobs: IngestJobName[] =
    specificJobs.length > 0
      ? Array.from(new Set(specificJobs))
      : ['payments', 'trustlines', 'trades'];

  return {
    command,
    db,
    postgres,
    interval,
    startLedger,
    maxTicks,
    confirmationLag,
    maxLedgers,
    once,
    from,
    to,
    horizon,
    anchors,
    jobs,
    help,
    version,
  };
}

type PgClient = import('pg').Client;

/**
 * Connect to Postgres.
 *
 * `pg` is imported dynamically so the SQLite path does not pay to load a driver
 * it never uses, and so a SQLite-only deployment is unaffected if the driver is
 * absent.
 */
async function connectPostgres(connectionString: string): Promise<PgClient> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

/**
 * A Postgres connection string with its password masked.
 *
 * Every command prints the database it is about to write to, and for Postgres
 * that string routinely carries credentials. Printing it verbatim would put them
 * in terminal scrollback, in CI logs, and in whatever collects those — so the
 * banner gets this instead.
 *
 * A string `URL` cannot parse is reported as the bare scheme rather than passed
 * through, because the reason it failed to parse might be the password.
 */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password) url.password = '***';
    return url.href;
  } catch {
    return '<unparseable connection string>';
  }
}

/** What the banner calls the database, without needing a connection first. */
function targetLabel(parsed: ParsedArgs): string {
  return parsed.postgres ? redactConnectionString(parsed.postgres) : (parsed.db ?? '');
}

/**
 * Reject the flag combinations no command accepts.
 *
 * One rule in one place: `migrate` has had it since #48 and `ingest`/`poll`
 * inherit exactly it, rather than growing a near-copy each.
 */
function engineProblem(parsed: ParsedArgs): string | undefined {
  if (parsed.db && parsed.postgres) {
    return 'Error: Pass either --db or --postgres, not both.';
  }
  if (!parsed.db && !parsed.postgres) {
    return 'Error: Missing required argument: one of --db <path> or --postgres <url>';
  }
  return undefined;
}

/**
 * An open database, whichever engine it is, ready for a job to write to.
 *
 * The engine branch is not only "which adapter" — it is also "which migration
 * runner", because `migrate` in ./db/migrate.ts takes a raw better-sqlite3
 * handle while `migratePostgres` takes a client. Resolving both here means
 * `ingest` and `poll` read identically and neither grows a second `if`.
 */
interface IngestionTarget {
  readonly sql: SqlAdapter;
  /** Apply pending migrations with this engine's runner. Returns versions applied. */
  migrate(): Promise<number[]>;
  /** Release the connection. Closes the underlying handle or client. */
  close(): Promise<void>;
}

async function openIngestionTarget(parsed: ParsedArgs): Promise<IngestionTarget> {
  if (parsed.postgres) {
    const client = await connectPostgres(parsed.postgres);
    // The adapter owns the client: nothing else here holds a reference, so the
    // `finally` that closes the target is the only place it can be released.
    const sql = pgAdapter(client, { closeConnection: true });
    return {
      sql,
      migrate: () => migratePostgres(client),
      close: () => sql.close(),
    };
  }

  const db = openDb(parsed.db!);
  const sql = sqliteAdapter(db, { closeHandle: true });
  return {
    sql,
    // `migrate` is the SQLite runner and takes the handle directly. Everything
    // downstream of it goes through the engine-neutral seam instead.
    migrate: () => Promise.resolve(migrate(db)),
    close: () => sql.close(),
  };
}

/** Apply migrations, for the `migrate` command. */
async function runMigrate(parsed: ParsedArgs): Promise<number> {
  const problem = engineProblem(parsed);
  if (problem) {
    console.error(problem);
    return 1;
  }

  let target: IngestionTarget;
  try {
    target = await openIngestionTarget(parsed);
  } catch (err) {
    console.error(`Migration failed: could not open ${targetLabel(parsed)}: ${errorText(err)}`);
    return 1;
  }

  try {
    const applied = await target.migrate();
    if (applied.length === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
    return 0;
  } catch (err) {
    console.error(`Migration failed: ${errorText(err)}`);
    return 1;
  } finally {
    await target.close();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Validate a numeric CLI flag, returning an error message or undefined. */
function invalidPositive(name: string, value: number | undefined, min: number): string | undefined {
  if (value === undefined) return undefined;
  if (isNaN(value) || !Number.isInteger(value) || value < min) {
    return `Error: Invalid ${name} (must be an integer >= ${String(min)})`;
  }
  return undefined;
}

async function runPoll(parsed: ParsedArgs): Promise<number> {
  const engine = engineProblem(parsed);
  if (engine) {
    console.error(engine);
    return 1;
  }

  for (const problem of [
    invalidPositive('--interval', parsed.interval, 1),
    invalidPositive('--start-ledger', parsed.startLedger, 1),
    invalidPositive('--max-ticks', parsed.maxTicks, 1),
    invalidPositive('--confirmation-lag', parsed.confirmationLag, 0),
    invalidPositive('--max-ledgers', parsed.maxLedgers, 1),
  ]) {
    if (problem) {
      console.error(problem);
      return 1;
    }
  }

  const intervalSeconds = parsed.interval ?? 30;
  const horizonUrl = parsed.horizon ?? 'https://horizon-testnet.stellar.org';
  const client = new HorizonClient({ baseUrl: horizonUrl });
  const jobs = parsed.jobs as IngestJob[];

  console.log(`Polling every ${String(intervalSeconds)}s`);
  console.log(`Database: ${targetLabel(parsed)}`);
  console.log(`Horizon:  ${horizonUrl}`);
  console.log(`Jobs:     ${jobs.join(', ')}`);

  let target: IngestionTarget;
  try {
    target = await openIngestionTarget(parsed);
  } catch (err) {
    console.error(`\nPolling failed: could not open ${targetLabel(parsed)}: ${errorText(err)}`);
    return 1;
  }

  const sql = target.sql;
  try {
    await target.migrate();

    const existing = await allIngestState(sql);
    if (existing.length === 0) {
      console.log('Watermarks: none recorded yet');
    } else {
      for (const state of existing) {
        console.log(`Watermark: ${state.job} at ledger ${String(state.last_ledger)}`);
      }
    }

    // Ctrl-C stops after the job in flight rather than mid-write, so a tick
    // never leaves a watermark claiming more than was actually processed.
    const controller = new AbortController();
    const onSignal = (): void => {
      console.log('\nStopping after the current job...');
      controller.abort();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      await poll(sql, client, {
        jobs,
        intervalSeconds,
        maxTicks: parsed.once ? 1 : parsed.maxTicks,
        startLedger: parsed.startLedger,
        confirmationLag: parsed.confirmationLag,
        maxLedgersPerPass: parsed.maxLedgers,
        signal: controller.signal,
        onPass: (result) => {
          if (!result.range) {
            console.log(
              `[${result.job}] up to date at ledger ${String(result.lastLedger ?? 0)} ` +
                `(head ${String(result.latestLedger)})`,
            );
            return;
          }
          console.log(
            `[${result.job}] ingested ${String(result.range.fromLedger)}..${String(result.range.toLedger)} ` +
              `(head ${String(result.latestLedger)})`,
          );
        },
      });
      return 0;
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  } catch (err) {
    console.error(`\nPolling failed: ${errorText(err)}`);
    return 1;
  } finally {
    // Reached on success, on failure, and after SIGINT -- the signal handler
    // aborts the loop and `poll` returns rather than exiting, so cleanup is not
    // skipped on the way out.
    await target.close();
  }
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  if (parsed.help || (!parsed.command && !parsed.version)) {
    console.log(HELP_TEXT.trim());
    return 0;
  }

  if (parsed.version) {
    console.log('xlm-flow-indexer 0.1.0');
    return 0;
  }

  if (parsed.command === 'migrate') {
    return await runMigrate(parsed);
  }

  if (parsed.command === 'poll') {
    return await runPoll(parsed);
  }

  if (parsed.command === 'ingest') {
    const engine = engineProblem(parsed);
    if (engine) {
      console.error(engine);
      return 1;
    }
    if (
      parsed.from === undefined ||
      isNaN(parsed.from) ||
      parsed.from <= 0 ||
      !Number.isInteger(parsed.from)
    ) {
      console.error('Error: Missing or invalid --from sequence (must be a positive integer)');
      return 1;
    }
    if (
      parsed.to === undefined ||
      isNaN(parsed.to) ||
      parsed.to <= 0 ||
      !Number.isInteger(parsed.to)
    ) {
      console.error('Error: Missing or invalid --to sequence (must be a positive integer)');
      return 1;
    }
    if (parsed.from > parsed.to) {
      console.error(
        `Error: Inverted ledger range: --from (${parsed.from}) cannot be greater than --to (${parsed.to})`,
      );
      return 1;
    }

    const range = { fromLedger: parsed.from, toLedger: parsed.to };
    const horizonUrl = parsed.horizon ?? 'https://horizon-testnet.stellar.org';
    const client = new HorizonClient({ baseUrl: horizonUrl });

    console.log(`Starting ingestion over ledgers ${range.fromLedger}..${range.toLedger}`);
    console.log(`Database: ${targetLabel(parsed)}`);
    console.log(`Horizon:  ${horizonUrl}`);
    console.log(`Jobs:     ${parsed.jobs.join(', ')}`);

    let target: IngestionTarget;
    try {
      target = await openIngestionTarget(parsed);
    } catch (err) {
      console.error(`\nIngestion failed: could not open ${targetLabel(parsed)}: ${errorText(err)}`);
      return 1;
    }

    try {
      const sql = target.sql;
      try {
        // Ensure migrations applied
        await target.migrate();

        // Load anchors if specified
        if (parsed.anchors) {
          if (!existsSync(parsed.anchors)) {
            console.error(`Error: Anchors config file not found: "${parsed.anchors}"`);
            return 1;
          }
          const loaded = await loadAnchorIssuers(sql, parsed.anchors);
          console.log(`Loaded ${loaded} anchor issuer(s) from "${parsed.anchors}".`);
        }

        for (const job of parsed.jobs) {
          if (job === 'payments') {
            console.log('\n[payments] Ingesting payment operations...');
            const res = await ingestPayments(sql, client, range);
            console.log(
              `[payments] Done: ${res.operationsScanned} ops scanned, ${res.paymentsWritten}/${res.paymentsSeen} payments written, ${res.accountsWritten} accounts, ${res.ledgersWritten} ledgers.`,
            );
          } else if (job === 'trustlines') {
            console.log('\n[trustlines] Ingesting trustline establishments...');
            const res = await ingestTrustlines(sql, client, range);
            console.log(
              `[trustlines] Done: ${res.effectsScanned} effects scanned, ${res.trustlinesWritten}/${res.trustlinesSeen} trustlines written, ${res.accountsWritten} accounts.`,
            );
          } else if (job === 'trades') {
            console.log('\n[trades] Ingesting DEX trades...');
            const res = await ingestTrades(sql, client, range);
            console.log(
              `[trades] Done: ${res.tradesSeen} trades seen (${res.orderbookTrades} orderbook, ${res.liquidityPoolTrades} pool), ${res.tradesWritten} trades written, ${res.ledgersWritten} ledgers.`,
            );
          }
        }

        console.log('\nIngestion completed successfully.');
        return 0;
      } finally {
        await target.close();
      }
    } catch (err) {
      console.error(`\nIngestion failed: ${errorText(err)}`);
      return 1;
    }
  }

  console.error(`Error: Unknown command "${parsed.command}". Run --help for available commands.`);
  return 1;
}

// Execute when run as script entrypoint
const isMain =
  process.argv[1]?.endsWith('cli.ts') ||
  process.argv[1]?.endsWith('cli.js') ||
  process.argv[1]?.endsWith('xlm-flow-indexer');
if (isMain) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
