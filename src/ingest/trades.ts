import type { Db } from '../db/client.ts';
import type { HorizonClient } from '../horizon/client.ts';
import { cursorBeforeLedger, ledgerOf } from '../horizon/toid.ts';
import type { HorizonTrade } from '../horizon/types.ts';
import type { LedgerRange } from './payments.ts';

/**
 * Trade mechanisms Horizon reports, and which this job stores.
 *
 * Both are ingested. Liquidity-pool trades were roughly half of all trades sampled on
 * testnet, so excluding them would discard about half of DEX activity — and PRD.md
 * names DEX trade patterns as a goal. They are stored with `trade_type` recorded so
 * `trade_pair_activity` (#10) can group or separate them deliberately, rather than
 * summing an order-book fill and an automated-market-maker swap as one figure.
 */
export const TRADE_TYPES = new Set(['orderbook', 'liquidity_pool']);

export interface TradeIngestResult {
  readonly tradesSeen: number;
  readonly ledgersWritten: number;
  readonly tradesWritten: number;
  readonly orderbookTrades: number;
  readonly liquidityPoolTrades: number;
  /** Records skipped because Horizon reported a `trade_type` we do not model. */
  readonly skippedUnknownType: number;
}

/**
 * Normalise one side of a trade into the schema's asset encoding.
 *
 * Horizon describes native XLM by `*_asset_type: 'native'` with the code and issuer
 * fields absent, so both are derived rather than read directly. `''` for the issuer
 * matches the encoding established in issue #1 — never NULL.
 *
 * Note that either side of a liquidity-pool trade can be the pool
 * (`base_liquidity_pool_id` or `counter_liquidity_pool_id`), but the asset columns are
 * populated in both cases, so the pool side needs no special handling here.
 */
function normaliseSide(
  assetType: string | undefined,
  assetCode: string | undefined,
  assetIssuer: string | undefined,
): { code: string; issuer: string } {
  if (assetType === 'native' || assetCode === undefined) {
    return { code: 'native', issuer: '' };
  }
  return { code: assetCode, issuer: assetIssuer ?? '' };
}

function tradeTypeOf(trade: HorizonTrade): string {
  // Horizon has reported trade_type since v2. Treat a missing value as order-book
  // rather than dropping the row: pre-v2 responses predate liquidity pools entirely,
  // so order-book is the only thing it could have been.
  return trade.trade_type ?? 'orderbook';
}

/**
 * Ingest trades for a ledger range into `trades`, with their `ledgers` parents.
 *
 * Idempotent by primary key: a second run over the same range writes nothing.
 */
export async function ingestTrades(
  db: Db,
  client: HorizonClient,
  range: LedgerRange,
): Promise<TradeIngestResult> {
  if (range.toLedger < range.fromLedger) {
    throw new RangeError(
      `Invalid ledger range: toLedger ${String(range.toLedger)} is before fromLedger ${String(range.fromLedger)}`,
    );
  }

  const insertLedger = db.prepare(
    `INSERT INTO ledgers (sequence, closed_at, operation_count)
     VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
  );
  const insertTrade = db.prepare(
    `INSERT INTO trades (
       id, ledger_sequence,
       base_asset_code, base_asset_issuer,
       counter_asset_code, counter_asset_issuer,
       base_amount, counter_amount, executed_at, trade_type
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );

  // Ledger parents first, for the same reason as the payments job: trades reference
  // ledgers(sequence) and foreign keys are enforced.
  let ledgersWritten = 0;
  for await (const ledger of client.ledgers({
    cursor: cursorBeforeLedger(range.fromLedger),
    order: 'asc',
    limit: 200,
  })) {
    if (ledger.sequence > range.toLedger) break;
    ledgersWritten += insertLedger.run(
      ledger.sequence,
      ledger.closed_at,
      ledger.operation_count,
    ).changes;
  }

  let tradesSeen = 0;
  let tradesWritten = 0;
  let orderbookTrades = 0;
  let liquidityPoolTrades = 0;
  let skippedUnknownType = 0;

  for await (const trade of client.trades({
    cursor: cursorBeforeLedger(range.fromLedger),
    order: 'asc',
    limit: 200,
  })) {
    const ledgerSequence = ledgerOf(trade.paging_token);
    if (ledgerSequence > range.toLedger) break;

    const tradeType = tradeTypeOf(trade);

    // A trade_type we do not model would violate the CHECK constraint and abort the
    // run. Counting and skipping surfaces the new mechanism without losing the rest
    // of the range -- and a non-zero count is the signal to add support for it.
    if (!TRADE_TYPES.has(tradeType)) {
      skippedUnknownType += 1;
      continue;
    }

    tradesSeen += 1;
    if (tradeType === 'liquidity_pool') liquidityPoolTrades += 1;
    else orderbookTrades += 1;

    const baseAsset = normaliseSide(
      trade.base_asset_type,
      trade.base_asset_code,
      trade.base_asset_issuer,
    );
    const counterAsset = normaliseSide(
      trade.counter_asset_type,
      trade.counter_asset_code,
      trade.counter_asset_issuer,
    );

    // Amounts written exactly as Horizon sent them; the TEXT columns exist so no
    // float round-trip happens anywhere in the write path.
    tradesWritten += insertTrade.run(
      trade.id,
      ledgerSequence,
      baseAsset.code,
      baseAsset.issuer,
      counterAsset.code,
      counterAsset.issuer,
      trade.base_amount,
      trade.counter_amount,
      trade.ledger_close_time,
      tradeType,
    ).changes;
  }

  return {
    tradesSeen,
    ledgersWritten,
    tradesWritten,
    orderbookTrades,
    liquidityPoolTrades,
    skippedUnknownType,
  };
}
