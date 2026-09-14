/**
 * Connection handling for the read-only dashboard.
 *
 * This is deliberately NOT `src/db/pg-adapter.ts`. That adapter exists to give
 * the ingestion jobs a single connection with real transaction semantics, and
 * it is out of scope for this slice (#78) — it is not imported, extended, or
 * modified here. The dashboard only ever issues single read-only statements,
 * which is the one workload a pool is actually correct for.
 *
 * `max: 1` because each serverless instance handles one request at a time, so
 * a larger pool per instance buys nothing and multiplies connections against
 * Neon's limit as instances scale out.
 */
import { Pool } from 'pg';

let pool: Pool | undefined;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Set it in the Vercel project settings (or .env.local for `next dev`).',
    );
  }
  return url;
}

/**
 * Module-level singleton: Next reuses the module across invocations on a warm
 * instance, so building a new Pool per request would leak connections.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: 1,
      // Close idle clients before the far end does. A managed pooler drops idle
      // connections on its own schedule, and a client that is still in our pool
      // when that happens is a dead socket we would only discover by failing a
      // query on it. Expiring ours first turns that into a fresh connect.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });

    // A pool emits 'error' for failures on *idle* clients, outside any query. It
    // is an EventEmitter, so with no listener Node treats that as an unhandled
    // error and takes the process down.
    pool.on('error', (error) => {
      console.error('idle client error', error);
    });
  }
  return pool;
}

/** True for failures that mean "the socket was dead", not "the query was bad". */
function isConnectionDrop(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    message.includes('Connection terminated') ||
    message.includes('server closed the connection')
  );
}

/**
 * Run one read-only statement and return its rows.
 *
 * Retried once, and only on a dropped connection. Every statement behind this is
 * a read, so re-running one cannot double-apply anything; the retry exists
 * because the first attempt can land on a pooled socket the far end has already
 * closed, which surfaces as ECONNRESET rather than as a query error. A second
 * attempt gets a fresh client. Anything that is not a connection drop — bad SQL,
 * a missing table — is rethrown immediately rather than tried again.
 */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    const result = await getPool().query(sql, params);
    return result.rows as T[];
  } catch (error) {
    if (!isConnectionDrop(error)) throw error;
    const result = await getPool().query(sql, params);
    return result.rows as T[];
  }
}

/**
 * Postgres returns `COUNT(*)` as int8 and `SUM(NUMERIC)` as numeric, and node-postgres
 * hands both back as *strings* to avoid silently truncating values that exceed
 * `Number.MAX_SAFE_INTEGER`. Every numeric field the routes emit goes through here so
 * the JSON carries numbers rather than a mix of numbers and strings.
 *
 * The precision caveat is real but bounded: a Stellar amount maxes out at
 * 922337203685.4775807, which is more than 2^53 stroops but well inside the range
 * where an IEEE double still represents the *displayed* magnitude faithfully. This is
 * a display surface, not an accounting one — anything summing money for real should
 * read NUMERIC out of the database directly.
 */
export function toNumber(value: string | number | null): number {
  if (value === null) return 0;
  return typeof value === 'number' ? value : Number(value);
}
