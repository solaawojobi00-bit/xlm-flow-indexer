#!/usr/bin/env node
import { existsSync } from 'node:fs';

import { loadAnchorIssuers } from './db/anchors.ts';
import { openDb } from './db/client.ts';
import { migrate } from './db/migrate.ts';
import { HorizonClient } from './horizon/client.ts';
import { ingestPayments } from './ingest/payments.ts';
import { ingestTrades } from './ingest/trades.ts';
import { ingestTrustlines } from './ingest/trustlines.ts';

export const HELP_TEXT = `
xlm-flow-indexer - Horizon ledger ingestion and analytics indexer

Usage:
  xlm-flow-indexer <command> [options]

Commands:
  migrate                 Apply pending schema migrations to the database
  ingest                  Ingest transactions and effects across a ledger range

Global Options:
  -h, --help              Show this help message
  -v, --version           Show version number

Command: migrate
  Options:
    --db <path>           Path to the SQLite database file (required)

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

Examples:
  xlm-flow-indexer migrate --db ./indexer.db
  xlm-flow-indexer ingest --from 4539850 --to 4539862 --db ./indexer.db
  xlm-flow-indexer ingest --from 4539850 --to 4539862 --db ./indexer.db --jobs payments,trades
`;

export type IngestJobName = 'payments' | 'trustlines' | 'trades';

interface ParsedArgs {
  command?: string;
  db?: string;
  from?: number;
  to?: number;
  horizon?: string;
  anchors?: string;
  jobs: IngestJobName[];
  help: boolean;
  version: boolean;
}

export function parseCliArgs(args: readonly string[]): ParsedArgs {
  let command: string | undefined;
  let db: string | undefined;
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

  return { command, db, from, to, horizon, anchors, jobs, help, version };
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
              `[trades] Done: ${res.tradesScanned} trades scanned (${res.orderbookTrades} orderbook, ${res.liquidityPoolTrades} pool), ${res.tradesWritten}/${res.tradesSeen} trades written, ${res.ledgersWritten} ledgers.`,
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
  runCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
