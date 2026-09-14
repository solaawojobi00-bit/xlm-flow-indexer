/**
 * GET /api/totals — row counts for the three things the indexer ingests.
 *
 * One query, no caching, no parameters (#78). The three counts are scalar
 * subqueries in a single statement rather than three round trips, because a
 * serverless invocation pays connection latency per query.
 */
import { NextResponse } from 'next/server';
import { query, toNumber } from '../../../lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TotalsRow {
  payment_count: string;
  trade_count: string;
  account_count: string;
}

const SQL = `
  SELECT
    (SELECT COUNT(*) FROM payments) AS payment_count,
    (SELECT COUNT(*) FROM trades)   AS trade_count,
    (SELECT COUNT(*) FROM accounts) AS account_count
`;

export async function GET() {
  try {
    const [row] = await query<TotalsRow>(SQL);
    return NextResponse.json({
      paymentCount: toNumber(row?.payment_count ?? null),
      tradeCount: toNumber(row?.trade_count ?? null),
      accountCount: toNumber(row?.account_count ?? null),
    });
  } catch (error) {
    console.error('GET /api/totals failed', error);
    return NextResponse.json({ error: 'Could not read ingestion totals.' }, { status: 500 });
  }
}
