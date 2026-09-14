/**
 * GET /api/coverage — how much of the ledger the indexer currently holds.
 *
 * One query, no caching, no parameters (#78).
 */
import { NextResponse } from 'next/server';
import { query, toNumber } from '../../../lib/db';

// `pg` is a Node library, and this must hit the database per request rather than
// be prerendered against whatever data existed at build time.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CoverageRow {
  ledger_count: string;
  min_ledger: string | null;
  max_ledger: string | null;
  // TIMESTAMPTZ, which node-postgres parses into a Date rather than handing back
  // the raw string. Normalised to ISO-8601 below so the JSON contract is one type.
  latest_closed_at: Date | string | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

const SQL = `
  SELECT
    COUNT(*)       AS ledger_count,
    MIN(sequence)  AS min_ledger,
    MAX(sequence)  AS max_ledger,
    MAX(closed_at) AS latest_closed_at
  FROM ledgers
`;

export async function GET() {
  try {
    const [row] = await query<CoverageRow>(SQL);
    return NextResponse.json({
      ledgerCount: toNumber(row?.ledger_count ?? null),
      minLedger: row?.min_ledger === null ? null : toNumber(row?.min_ledger ?? null),
      maxLedger: row?.max_ledger === null ? null : toNumber(row?.max_ledger ?? null),
      latestClosedAt: toIso(row?.latest_closed_at),
    });
  } catch (error) {
    // The message can carry the host from a connection string, so it is logged
    // rather than returned.
    console.error('GET /api/coverage failed', error);
    return NextResponse.json({ error: 'Could not read ledger coverage.' }, { status: 500 });
  }
}
