/**
 * Confirm a deployment's read surface still works (issue #81).
 *
 * Written for credential rotation. Rotating `DATABASE_URL` is four console
 * actions — new role, new value in Vercel, redeploy, revoke the old role — and
 * the only thing that proves the sequence landed is that the deployed routes
 * still read the database. The dashboard is read-only and unauthenticated, so
 * that proof is three HTTP requests and needs no credential of its own: this
 * script never touches a connection string, which is the point. The person
 * running it does not need the secret they just rotated.
 *
 *   node scripts/verify-deployment.ts
 *   node scripts/verify-deployment.ts --base-url https://my-deployment.vercel.app
 *
 * Exits 0 only if every endpoint answered 200 with a body matching its
 * documented contract. Anything else exits 1.
 *
 * ---------------------------------------------------------------------------
 * Why the check is not just the status code
 * ---------------------------------------------------------------------------
 * The three routes catch their own database errors and answer 500 (see
 * web/app/api/*\/route.ts), so a revoked-but-not-replaced credential does show up
 * as a non-200. Two rotation mistakes do not:
 *
 *   - A new role that connects but was created against a different database —
 *     easy to do in the Neon console, where a role and a database are separate
 *     objects. Every query succeeds against empty tables and every route returns
 *     200. `ledgerCount: 0` is the tell, so an empty `ledgers` table is a
 *     failure here unless `--allow-empty` says otherwise.
 *   - A redeploy that did not actually pick up the new value, leaving the old
 *     credential live. That one is only visible *after* step 4 revokes it, which
 *     is why the runbook in README.md re-runs this script after the revoke
 *     rather than only before.
 */

interface Check {
  readonly path: string;
  /** Rejects a 200 whose body does not match the route's contract. */
  readonly validate: (body: unknown, options: Required<VerifyOptions>) => string | null;
}

export interface VerifyOptions {
  /** Accept a deployment whose `ledgers` table is empty. Off by default. */
  readonly allowEmpty?: boolean;
  /** Per-request budget. Generous by default: a redeploy leaves cold instances. */
  readonly timeoutMs?: number;
}

export interface EndpointResult {
  readonly path: string;
  readonly ok: boolean;
  /** `null` when the request produced no response at all (DNS, refused, timeout). */
  readonly status: number | null;
  /** Empty when `ok`; otherwise why it failed. */
  readonly detail: string;
}

export interface VerifyResult {
  readonly baseUrl: string;
  readonly ok: boolean;
  readonly results: readonly EndpointResult[];
}

export const DEFAULT_BASE_URL = 'https://xlm-flow-indexer.vercel.app';
const DEFAULT_TIMEOUT_MS = 15_000;

/** Longest body excerpt echoed into a failure detail. */
const BODY_EXCERPT_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The routes emit JSON numbers for every count, so a string here is a contract break. */
function badNumber(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'number' && Number.isFinite(value) ? null : `${field} is not a number`;
}

function badNullableNumber(body: Record<string, unknown>, field: string): string | null {
  return body[field] === null ? null : badNumber(body, field);
}

function firstProblem(...checks: (string | null)[]): string | null {
  return checks.find((problem) => problem !== null) ?? null;
}

const CHECKS: readonly Check[] = [
  {
    path: '/api/coverage',
    validate: (body, options) => {
      if (!isRecord(body)) return 'body is not a JSON object';
      const shape = firstProblem(
        badNumber(body, 'ledgerCount'),
        badNullableNumber(body, 'minLedger'),
        badNullableNumber(body, 'maxLedger'),
      );
      if (shape !== null) return shape;
      if (!options.allowEmpty && body.ledgerCount === 0) {
        return 'returned 200 but reports 0 ledgers — the deployment may be pointed at a different or unmigrated database (pass --allow-empty if this is expected)';
      }
      return null;
    },
  },
  {
    path: '/api/totals',
    validate: (body) => {
      if (!isRecord(body)) return 'body is not a JSON object';
      return firstProblem(
        badNumber(body, 'paymentCount'),
        badNumber(body, 'tradeCount'),
        badNumber(body, 'accountCount'),
      );
    },
  },
  {
    path: '/api/assets',
    validate: (body) => {
      if (!isRecord(body)) return 'body is not a JSON object';
      const { assets } = body;
      if (!Array.isArray(assets)) return 'assets is not an array';
      for (const [index, asset] of assets.entries()) {
        if (!isRecord(asset)) return `assets[${String(index)}] is not an object`;
        const problem = firstProblem(
          typeof asset.assetCode === 'string' ? null : 'assetCode is not a string',
          badNumber(asset, 'transferCount'),
          badNumber(asset, 'totalVolume'),
          badNumber(asset, 'activeDays'),
        );
        if (problem !== null) return `assets[${String(index)}]: ${problem}`;
      }
      return null;
    },
  },
];

export const ENDPOINT_PATHS: readonly string[] = CHECKS.map((check) => check.path);

function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > BODY_EXCERPT_LIMIT
    ? `${collapsed.slice(0, BODY_EXCERPT_LIMIT)}…`
    : collapsed;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // fetch wraps the real cause (ECONNREFUSED, DNS failure) in a flat
  // 'fetch failed', which on its own says nothing about what went wrong.
  const cause = error.cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

async function runCheck(
  baseUrl: string,
  check: Check,
  options: Required<VerifyOptions>,
): Promise<EndpointResult> {
  const url = new URL(check.path, baseUrl);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: { accept: 'application/json' },
      // A cached 200 from before the rotation would be indistinguishable from a
      // live one, and proving the *running* instance can reach the database is
      // the entire question.
      cache: 'no-store',
    });
  } catch (error) {
    return { path: check.path, ok: false, status: null, detail: errorText(error) };
  }

  const text = await response.text();
  if (response.status !== 200) {
    return {
      path: check.path,
      ok: false,
      status: response.status,
      detail: `expected 200, got ${String(response.status)}${text === '' ? '' : ` — ${excerpt(text)}`}`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      path: check.path,
      ok: false,
      status: response.status,
      detail: `200 but body is not JSON — ${excerpt(text)}`,
    };
  }

  const problem = check.validate(body, options);
  return problem === null
    ? { path: check.path, ok: true, status: response.status, detail: '' }
    : { path: check.path, ok: false, status: response.status, detail: problem };
}

/**
 * Request every endpoint and report each one.
 *
 * Sequential, and every endpoint is checked even after one fails: the three
 * routes read different tables, so which ones broke is the diagnosis. Stopping
 * at the first failure would throw that away.
 */
export async function verifyDeployment(
  baseUrl: string = DEFAULT_BASE_URL,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const resolved: Required<VerifyOptions> = {
    allowEmpty: options.allowEmpty ?? false,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  const results: EndpointResult[] = [];
  for (const check of CHECKS) {
    results.push(await runCheck(baseUrl, check, resolved));
  }

  return { baseUrl, ok: results.every((result) => result.ok), results };
}

export function formatResult(result: VerifyResult): string {
  const lines = [`Verifying ${result.baseUrl}`, ''];
  for (const endpoint of result.results) {
    const status = endpoint.status === null ? 'no response' : String(endpoint.status);
    lines.push(
      endpoint.ok
        ? `  PASS  GET ${endpoint.path} -> ${status}`
        : `  FAIL  GET ${endpoint.path} -> ${status}: ${endpoint.detail}`,
    );
  }
  lines.push('');
  lines.push(
    result.ok
      ? `All ${String(result.results.length)} endpoints OK.`
      : `${String(result.results.filter((endpoint) => !endpoint.ok).length)} of ${String(result.results.length)} endpoints failed.`,
  );
  return lines.join('\n');
}

const USAGE = `Usage: node scripts/verify-deployment.ts [options]

Checks that a deployment's read-only API still answers 200 with well-formed
bodies. Used after rotating DATABASE_URL (issue #81).

Options:
  --base-url <url>   Deployment to check. Defaults to $DEPLOYMENT_URL, then
                     ${DEFAULT_BASE_URL}
  --timeout <ms>     Per-request timeout. Default ${String(DEFAULT_TIMEOUT_MS)}
  --allow-empty      Treat a deployment with 0 ledgers as healthy
  -h, --help         Show this message`;

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const options: { allowEmpty: boolean; timeoutMs?: number } = { allowEmpty: false };
  let baseUrl = env.DEPLOYMENT_URL ?? DEFAULT_BASE_URL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        console.log(USAGE);
        return 0;
      case '--allow-empty':
        options.allowEmpty = true;
        break;
      case '--base-url': {
        const value = argv[++i];
        if (value === undefined) {
          console.error('Error: --base-url requires a URL');
          return 1;
        }
        baseUrl = value;
        break;
      }
      case '--timeout': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) {
          console.error('Error: --timeout requires a positive number of milliseconds');
          return 1;
        }
        options.timeoutMs = value;
        break;
      }
      default:
        console.error(`Error: unknown argument "${String(arg)}". Run --help for usage.`);
        return 1;
    }
  }

  try {
    new URL(baseUrl);
  } catch {
    console.error(`Error: "${baseUrl}" is not a valid URL`);
    return 1;
  }

  const result = await verifyDeployment(baseUrl, options);
  console.log(formatResult(result));
  return result.ok ? 0 : 1;
}

// Execute when run as script entrypoint, not when imported by the test suite.
const isMain =
  process.argv[1]?.endsWith('verify-deployment.ts') === true ||
  process.argv[1]?.endsWith('verify-deployment.js') === true;
if (isMain) {
  process.exitCode = await main(process.argv.slice(2));
}
