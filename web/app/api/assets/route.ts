/**
 * GET /api/assets — the most active assets, read straight off `asset_velocity`.
 *
 * One query, no caching, no parameters (#78).
 *
 * `asset_velocity` has a daily grain by design (see migration 004: a view cannot
 * take a window parameter, so callers aggregate the days they want). This route
 * wants all-time totals, so it sums across every day present.
 *
 * `transfer_count` and `total_volume` are additive across days and are summed.
 * `distinct_senders` and `distinct_receivers` are deliberately NOT summed: they
 * are per-day distinct counts, so an account active on ten days would be counted
 * ten times and the result would not be a distinct count of anything. Recovering a
 * true all-time distinct count means going back to `payments`, which is more than
 * this slice needs — so the column is reported as `activeDays` instead, which the
 * daily grain does support honestly.
 */
import { NextResponse } from 'next/server';
import { query, toNumber } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AssetRow {
  asset_code: string;
  asset_issuer: string;
  transfer_count: string;
  total_volume: string | null;
  active_days: string;
}

// Tiebreak on asset_code so equal volumes do not reorder between requests.
const SQL = `
  SELECT
    asset_code,
    asset_issuer,
    SUM(transfer_count) AS transfer_count,
    SUM(total_volume)   AS total_volume,
    COUNT(*)            AS active_days
  FROM asset_velocity
  GROUP BY asset_code, asset_issuer
  ORDER BY SUM(total_volume) DESC, asset_code ASC
  LIMIT 20
`;

export async function GET() {
  try {
    const rows = await query<AssetRow>(SQL);
    return NextResponse.json({
      assets: rows.map((row) => ({
        assetCode: row.asset_code,
        // '' is the repo's encoding for "native, no issuer" — see ARCHITECTURE.md.
        assetIssuer: row.asset_issuer === '' ? null : row.asset_issuer,
        transferCount: toNumber(row.transfer_count),
        totalVolume: toNumber(row.total_volume),
        activeDays: toNumber(row.active_days),
      })),
    });
  } catch (error) {
    console.error('GET /api/assets failed', error);
    return NextResponse.json({ error: 'Could not read asset activity.' }, { status: 500 });
  }
}
