import type { SqlAdapter } from '../db/adapter.ts';
import type { HorizonClient } from '../horizon/client.ts';
import { cursorBeforeLedger, ledgerOf } from '../horizon/toid.ts';
import type { HorizonLedger, HorizonOperation } from '../horizon/types.ts';

/**
 * Operation types that move value between two accounts and therefore belong in
 * `payments`.
 *
 * `create_account` and `account_merge` also move value but are deliberately excluded:
 * BACKLOG.md item 3 scopes this job to payment-type operations, and both of those have
 * no asset (they are always native) and no symmetric from/to shape. Revisit only if a
 * view needs them.
 */
export const PAYMENT_TYPES = new Set([
  'payment',
  'path_payment_strict_send',
  'path_payment_strict_receive',
]);

export interface LedgerRange {
  readonly fromLedger: number;
  readonly toLedger: number;
}

export interface IngestResult {
  /** Operations examined, whatever their type. */
  readonly operationsScanned: number;
  /** Payment-type operations written or already present. */
  readonly paymentsSeen: number;
  readonly ledgersWritten: number;
  readonly accountsWritten: number;
  readonly operationsWritten: number;
  readonly paymentsWritten: number;
}

/**
 * Normalise a Horizon asset into the encoding the schema uses.
 *
 * Horizon describes native XLM with `asset_type: 'native'` and no code or issuer
 * fields at all. The schema stores `'native'` / `''` — never NULL — because a NULL
 * issuer silently defeats the trustlines primary key in SQLite and errors outright in
 * Postgres. See issue #1.
 */
export function normaliseAsset(op: {
  asset_type?: string | undefined;
  asset_code?: string | undefined;
  asset_issuer?: string | undefined;
}): { code: string; issuer: string } {
  if (op.asset_type === 'native' || op.asset_code === undefined) {
    return { code: 'native', issuer: '' };
  }
  return { code: op.asset_code, issuer: op.asset_issuer ?? '' };
}

/**
 * The value actually delivered to the destination.
 *
 * For a plain payment this is `amount`. For both path payment variants Horizon also
 * reports `source_amount` and the source asset, which describe what the sender spent
 * in a different asset; the destination side is what `payments` records, so the
 * `amount`/`asset_*` fields are correct for all three types without special-casing.
 */
function destinationAmount(op: HorizonOperation): string | undefined {
  return op.amount;
}

// ON CONFLICT DO NOTHING throughout: re-running over an ingested range must be a
// no-op rather than a duplicate-row error. This is the property BACKLOG.md item 6
// exists to prove and item 18's incremental ingestion depends on. The bare form --
// no conflict target -- is read identically by both engines, so these need no
// dialect token.
//
// Module constants rather than statements prepared per call. The adapter compiles
// each of these once per connection and reuses it (see ../db/sqlite-adapter.ts),
// which is what the old hoisted-`prepare` shape was buying.
const INSERT_LEDGER = `INSERT INTO ledgers (sequence, closed_at, operation_count)
   VALUES (?, ?, ?) ON CONFLICT DO NOTHING`;

const INSERT_ACCOUNT = 'INSERT INTO accounts (account_id) VALUES (?) ON CONFLICT DO NOTHING';

const INSERT_OPERATION = `INSERT INTO operations (id, ledger_sequence, type, source_account, created_at)
   VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;

const INSERT_PAYMENT = `INSERT INTO payments
     (operation_id, from_account, to_account, asset_code, asset_issuer, amount)
   VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;

/**
 * Ingest the ledgers covering a range.
 *
 * Runs before the operations pass because `operations.ledger_sequence` references
 * `ledgers(sequence)`, and with `PRAGMA foreign_keys = ON` an operation whose ledger
 * is missing is rejected rather than silently orphaned.
 */
async function ingestLedgers(
  db: SqlAdapter,
  client: HorizonClient,
  range: LedgerRange,
): Promise<number> {
  let written = 0;

  for await (const ledger of client.ledgers({
    cursor: cursorBeforeLedger(range.fromLedger),
    order: 'asc',
    limit: 200,
  })) {
    if (ledger.sequence > range.toLedger) break;
    const info = await db.run(INSERT_LEDGER, [
      ledger.sequence,
      ledger.closed_at,
      ledger.operation_count,
    ]);
    written += info.rowsAffected;
  }

  return written;
}

/**
 * Ingest payment-type operations for a ledger range into `payments` + `operations`.
 *
 * Idempotent by primary key: running it twice over the same range writes nothing the
 * second time.
 */
export async function ingestPayments(
  db: SqlAdapter,
  client: HorizonClient,
  range: LedgerRange,
): Promise<IngestResult> {
  if (range.toLedger < range.fromLedger) {
    throw new RangeError(
      `Invalid ledger range: toLedger ${String(range.toLedger)} is before fromLedger ${String(range.fromLedger)}`,
    );
  }

  const ledgersWritten = await ingestLedgers(db, client, range);

  let operationsScanned = 0;
  let paymentsSeen = 0;
  let accountsWritten = 0;
  let operationsWritten = 0;
  let paymentsWritten = 0;

  for await (const op of client.operations({
    cursor: cursorBeforeLedger(range.fromLedger),
    order: 'asc',
    limit: 200,
  })) {
    const ledgerSequence = ledgerOf(op.paging_token);

    // Horizon has no ledger-range filter, so the range ends where the records do.
    if (ledgerSequence > range.toLedger) break;

    operationsScanned += 1;
    if (!PAYMENT_TYPES.has(op.type)) continue;

    const amount = destinationAmount(op);
    const from = op.from;
    const to = op.to;

    // A payment-type operation missing any of these is malformed rather than merely
    // unusual. Skipping is safer than writing a half row that a view would later
    // aggregate as if it were real.
    if (amount === undefined || from === undefined || to === undefined) continue;

    paymentsSeen += 1;
    const asset = normaliseAsset(op);

    // Parents before children, so the foreign keys hold.
    for (const account of new Set([op.source_account, from, to])) {
      accountsWritten += (await db.run(INSERT_ACCOUNT, [account])).rowsAffected;
    }

    operationsWritten += (
      await db.run(INSERT_OPERATION, [
        op.id,
        ledgerSequence,
        op.type,
        op.source_account,
        op.created_at,
      ])
    ).rowsAffected;

    // amount is written exactly as Horizon sent it. Any numeric round-trip here would
    // reintroduce the float precision loss the TEXT column exists to avoid.
    paymentsWritten += (
      await db.run(INSERT_PAYMENT, [op.id, from, to, asset.code, asset.issuer, amount])
    ).rowsAffected;
  }

  return {
    operationsScanned,
    paymentsSeen,
    ledgersWritten,
    accountsWritten,
    operationsWritten,
    paymentsWritten,
  };
}

export type { HorizonLedger };
