#!/usr/bin/env node
import { existsSync } from 'node:fs';

import { loadAnchorIssuers } from './db/anchors.ts';
import { openDb } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { migratePostgres } from './db/postgres.ts';
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
    --db <path>           Path to the SQLite database file (required)
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
    --db <path>           Path to the SQLite database file (required)
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
  xlm-flow-indexer poll --db ./indexer.db --start-ledger 4539850 --interval 30
  xlm-flow-indexer poll --db ./indexer.db --once
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

/**
 * Apply migrations to Postgres.
 *
 * `pg` is imported dynamically so the SQLite path -- which is every current
 * command other than this one -- does not pay to load a driver it never uses,
 * and so a SQLite-only deployment is unaffected if the driver is absent.
 */
async function migrateToPostgres(connectionString: string): Promise<number> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString });

  try {
    await client.connect();
  } catch (err) {
    console.error(`Migration failed: could not connect to Postgres: ${(err as Error).message}`);
    return 1;
  }

  try {
    const applied = await migratePostgres(client);
    if (applied.length === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
    return 0;
  } catch (err) {
    console.error(`Migration failed: ${(err as Error).message}`);
    return 1;
  } finally {
    await client.end();
  }
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
  if (!parsed.db) {
    console.error('Error: Missing required argument --db <path>');
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
  console.log(`Database: ${parsed.db}`);
  console.log(`Horizon:  ${horizonUrl}`);
  console.log(`Jobs:     ${jobs.join(', ')}`);

  const db = openDb(parsed.db);
  try {
    migrate(db);

    const existing = allIngestState(db);
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
      await poll(db, client, {
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
    console.error(`\nPolling failed: ${(err as Error).message}`);
    return 1;
  } finally {
    db.close();
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
    if (parsed.postgres) {
      if (parsed.db) {
        console.error('Error: Pass either --db or --postgres, not both.');
        return 1;
      }
      return await migrateToPostgres(parsed.postgres);
    }

    if (!parsed.db) {
      console.error('Error: Missing required argument --db <path>');
      return 1;
    }

    try {
      const db = openDb(parsed.db);
      try {
        const applied = migrate(db);
        if (applied.length === 0) {
          console.log('No pending migrations.');
        } else {
          console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
        }
        return 0;
      } finally {
        db.close();
      }
    } catch (err) {
      console.error(`Migration failed: ${(err as Error).message}`);
      return 1;
    }
  }

  if (parsed.command === 'poll') {
    return await runPoll(parsed);
  }

  if (parsed.command === 'ingest') {
    if (!parsed.db) {
      console.error('Error: Missing required argument --db <path>');
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
    console.log(`Database: ${parsed.db}`);
    console.log(`Horizon:  ${horizonUrl}`);
    console.log(`Jobs:     ${parsed.jobs.join(', ')}`);

    try {
      const db = openDb(parsed.db);
      try {
        // Ensure migrations applied
        migrate(db);

        // Load anchors if specified
        if (parsed.anchors) {
          if (!existsSync(parsed.anchors)) {
            console.error(`Error: Anchors config file not found: "${parsed.anchors}"`);
            return 1;
          }
          const loaded = loadAnchorIssuers(db, parsed.anchors);
          console.log(`Loaded ${loaded} anchor issuer(s) from "${parsed.anchors}".`);
        }

        for (const job of parsed.jobs) {
          if (job === 'payments') {
            console.log('\n[payments] Ingesting payment operations...');
            const res = await ingestPayments(db, client, range);
            console.log(
              `[payments] Done: ${res.operationsScanned} ops scanned, ${res.paymentsWritten}/${res.paymentsSeen} payments written, ${res.accountsWritten} accounts, ${res.ledgersWritten} ledgers.`,
            );
          } else if (job === 'trustlines') {
            console.log('\n[trustlines] Ingesting trustline establishments...');
            const res = await ingestTrustlines(db, client, range);
            console.log(
              `[trustlines] Done: ${res.effectsScanned} effects scanned, ${res.trustlinesWritten}/${res.trustlinesSeen} trustlines written, ${res.accountsWritten} accounts.`,
            );
          } else if (job === 'trades') {
            console.log('\n[trades] Ingesting DEX trades...');
            const res = await ingestTrades(db, client, range);
            console.log(
              `[trades] Done: ${res.tradesSeen} trades seen (${res.orderbookTrades} orderbook, ${res.liquidityPoolTrades} pool), ${res.tradesWritten} trades written, ${res.ledgersWritten} ledgers.`,
            );
          }
        }

        console.log('\nIngestion completed successfully.');
        return 0;
      } finally {
        db.close();
      }
    } catch (err) {
      console.error(`\nIngestion failed: ${(err as Error).message}`);
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
