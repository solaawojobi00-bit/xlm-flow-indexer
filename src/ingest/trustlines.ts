import type { SqlAdapter } from '../db/adapter.ts';
import type { HorizonClient } from '../horizon/client.ts';
import { cursorBeforeLedger, ledgerOf } from '../horizon/toid.ts';
import type { LedgerRange } from './payments.ts';
import { normaliseAsset } from './payments.ts';

/**
 * Horizon effect that marks a trustline coming into existence.
 *
 * Deliberately only `trustline_created`, not the `change_trust` *operation*.
 * A `change_trust` with a non-zero limit against a line that already exists is an
 * update, and reading operations would record it as a fresh establishment. Horizon
 * already does the work of distinguishing the two and reports `trustline_updated` for
 * the second case, so the effects stream is the correct source.
 */
const TRUSTLINE_CREATED = 'trustline_created';

export interface TrustlineIngestResult {
  readonly effectsScanned: number;
  /** `trustline_created` effects seen, whether or not they were new to us. */
  readonly trustlinesSeen: number;
  readonly accountsWritten: number;
  readonly trustlinesWritten: number;
}

/**
 * Ingest trustline establishment for a ledger range.
 *
 * Idempotent by primary key `(account_id, asset_code, asset_issuer)`.
 *
 * **Re-establishment policy: the earliest `established_at` wins.** A trustline that is
 * removed and later created again produces a second `trustline_created` effect, and
 * `ON CONFLICT DO NOTHING` keeps the first. That is the deliberate choice rather than
 * an accident of the conflict clause:
 *
 * - The column is named `established_at`, and first establishment is what it claims to
 *   describe.
 * - The schema records no removal, so overwriting with a later timestamp would imply a
 *   continuous trustline since that date, which is false.
 * - It keeps ingestion order-independent. Overwriting would make the final value depend
 *   on which range was ingested last, so a backfill could silently change history.
 *
 * If Phase 3 needs re-establishment history, it needs a separate event table rather
 * than a mutable column here.
 */
export async function ingestTrustlines(
  db: SqlAdapter,
  client: HorizonClient,
  range: LedgerRange,
): Promise<TrustlineIngestResult> {
  if (range.toLedger < range.fromLedger) {
    throw new RangeError(
      `Invalid ledger range: toLedger ${String(range.toLedger)} is before fromLedger ${String(range.fromLedger)}`,
    );
  }

  const insertAccount = 'INSERT INTO accounts (account_id) VALUES (?) ON CONFLICT DO NOTHING';
  const insertTrustline = `INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`;

  let effectsScanned = 0;
  let trustlinesSeen = 0;
  let accountsWritten = 0;
  let trustlinesWritten = 0;

  for await (const effect of client.effects({
    cursor: cursorBeforeLedger(range.fromLedger),
    order: 'asc',
    limit: 200,
  })) {
    if (ledgerOf(effect.paging_token) > range.toLedger) break;

    effectsScanned += 1;
    if (effect.type !== TRUSTLINE_CREATED) continue;

    const asset = normaliseAsset(effect);

    // A trustline to native is not a thing on Stellar -- every account holds XLM
    // without one. An effect claiming otherwise is malformed, and writing it would put
    // a row in trustlines that no real trustline corresponds to.
    if (asset.code === 'native') continue;

    trustlinesSeen += 1;

    // Parent before child, so the foreign key holds.
    accountsWritten += (await db.run(insertAccount, [effect.account])).rowsAffected;
    trustlinesWritten += (
      await db.run(insertTrustline, [effect.account, asset.code, asset.issuer, effect.created_at])
    ).rowsAffected;
  }

  return { effectsScanned, trustlinesSeen, accountsWritten, trustlinesWritten };
}
