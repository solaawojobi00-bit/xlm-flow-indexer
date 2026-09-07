/**
 * Record real Horizon responses for a ledger range into a replayable fixture.
 *
 * Why this exists: ARCHITECTURE.md requires Phase 1 to be verified against a real,
 * fixed testnet ledger range, and PRD.md forbids substituting invented data for the
 * ingestion pipeline. But Stellar testnet is reset periodically, which deletes the
 * pinned range -- so a CI suite that queries testnet directly goes red on Stellar's
 * schedule rather than on ours.
 *
 * The resolution is to record real responses once and replay them in CI. The data is
 * genuinely Horizon's, byte for byte; only the transport is replaced. Nothing here
 * fabricates or edits a response.
 *
 * After a testnet reset, re-run this against a fresh range and update the README:
 *
 *   node scripts/capture-fixtures.ts --job payments   --from 4539850 --to 4539862
 *   node scripts/capture-fixtures.ts --job trustlines --from 4540630 --to 4540680
 *
 * Each job gets its own range because testnet activity is uneven: the range with
 * payment traffic contains no trustline effects at all, and vice versa.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HorizonClient } from '../src/horizon/client.ts';
import { openDb } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { ingestPayments } from '../src/ingest/payments.ts';
import { ingestTrades } from '../src/ingest/trades.ts';
import { ingestTrustlines } from '../src/ingest/trustlines.ts';

const DEFAULT_HORIZON = 'https://horizon-testnet.stellar.org';
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

export interface Fixture {
  readonly job: string;
  readonly capturedAt: string;
  readonly horizonUrl: string;
  readonly networkPassphrase: string;
  readonly horizonVersion: string;
  readonly fromLedger: number;
  readonly toLedger: number;
  /** Request path plus query string, mapped to the exact JSON body Horizon returned. */
  readonly responses: Record<string, unknown>;
}

const JOBS = ['payments', 'trustlines', 'trades'] as const;
type JobName = (typeof JOBS)[number];

function isJobName(value: string): value is JobName {
  return (JOBS as readonly string[]).includes(value);
}

interface Args {
  readonly job: JobName;
  readonly from: number;
  readonly to: number;
  readonly horizonUrl: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const usage =
    'Usage: node scripts/capture-fixtures.ts --job <payments|trustlines|trades> --from <ledger> --to <ledger>';

  const job = get('--job') ?? 'payments';
  if (!isJobName(job)) throw new Error(usage);

  const from = Number(get('--from'));
  const to = Number(get('--to'));
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(usage);

  return { job, from, to, horizonUrl: get('--horizon') ?? DEFAULT_HORIZON };
}

async function main(argv: string[]): Promise<number> {
  const { job, from, to, horizonUrl } = parseArgs(argv);

  const responses: Record<string, unknown> = {};

  // Wrap fetch so every response the real ingestion asks for is recorded verbatim.
  // Driving the capture with the actual ingestion, rather than a bespoke crawl,
  // guarantees the fixture contains exactly the requests the code makes -- a
  // hand-written capture would drift the moment paging changed.
  const recordingFetch: typeof globalThis.fetch = async (input, init) => {
    // fetch accepts a string, a URL, or a Request. Only the first two are ever passed
    // here, but reading .url off a Request is the correct third case rather than
    // stringifying it into '[object Object]'.
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const response = await globalThis.fetch(url, init);
    const body = await response.clone().text();
    responses[`${url.pathname}${url.search}`] = JSON.parse(body);
    return response;
  };

  const meta = (await (await globalThis.fetch(horizonUrl)).json()) as {
    network_passphrase: string;
    horizon_version: string;
  };

  const client = new HorizonClient({ baseUrl: horizonUrl, fetch: recordingFetch });

  // Ingest into a throwaway in-memory database purely to exercise the real code path.
  const db = openDb(':memory:');
  migrate(db);
  const range = { fromLedger: from, toLedger: to };
  const summary =
    job === 'payments'
      ? await ingestPayments(db, client, range)
      : job === 'trades'
        ? await ingestTrades(db, client, range)
        : await ingestTrustlines(db, client, range);
  db.close();

  const fixture: Fixture = {
    job,
    capturedAt: new Date().toISOString(),
    horizonUrl,
    networkPassphrase: meta.network_passphrase,
    horizonVersion: meta.horizon_version,
    fromLedger: from,
    toLedger: to,
    responses,
  };

  const dir = join(FIXTURE_ROOT, `testnet-${job}-${String(from)}-${String(to)}`);
  mkdirSync(dir, { recursive: true });
  // Written minified. The recorded bodies are identical either way, and pretty
  // printing inflates a fixture this size by roughly a third for a diff nobody can
  // usefully read.
  writeFileSync(join(dir, 'horizon.json'), `${JSON.stringify(fixture)}\n`, 'utf8');

  console.log(`Captured ${String(Object.keys(responses).length)} responses to ${dir}`);
  for (const [key, value] of Object.entries(summary)) {
    console.log(`  ${key.padEnd(20)} ${String(value)}`);
  }
  return 0;
}

// Set the code and let Node exit once handles drain, rather than calling
// process.exit(). Exiting immediately after async work races libuv's teardown of the
// still-closing HTTP sockets, which aborts with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" on Windows -- after the
// work has succeeded, so it would present as a spurious failure.
process.exitCode = await main(process.argv.slice(2));
