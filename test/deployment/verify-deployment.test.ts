import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import {
  DEFAULT_BASE_URL,
  ENDPOINT_PATHS,
  formatResult,
  main,
  verifyDeployment,
} from '../../scripts/verify-deployment.ts';

/**
 * The post-rotation deployment check (issue #81).
 *
 * Driven against a real HTTP server over a real socket, not a stubbed `fetch`:
 * the thing under test is whether the script correctly reads what a deployment
 * actually sends back, so the transport, the status line and the body all stay
 * in the path. The bodies below are the shapes the three routes in `web/app/api`
 * emit, and the failure bodies are the ones they emit on a database error —
 * which is exactly what a botched credential rotation produces.
 */

/** A healthy response per endpoint, matching the route contracts in web/app/api. */
const HEALTHY: Record<string, unknown> = {
  '/api/coverage': {
    ledgerCount: 720,
    minLedger: 4679079,
    maxLedger: 4679798,
    latestClosedAt: '2026-09-14T21:49:37.000Z',
  },
  '/api/totals': { paymentCount: 412, tradeCount: 88, accountCount: 530 },
  '/api/assets': {
    assets: [
      {
        assetCode: 'XLM',
        assetIssuer: null,
        transferCount: 300,
        totalVolume: 12345.678,
        activeDays: 1,
      },
    ],
  },
};

interface Response {
  readonly status?: number;
  /** Serialised as JSON unless it is a string, which is sent verbatim. */
  readonly body: unknown;
}

interface Deployment {
  readonly baseUrl: string;
  readonly requests: string[];
  close(): Promise<void>;
}

/** Serve `overrides` where given, the healthy body everywhere else. */
async function startDeployment(overrides: Record<string, Response> = {}): Promise<Deployment> {
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(path);

    const override = overrides[path];
    const status = override?.status ?? 200;
    const body = override === undefined ? HEALTHY[path] : override.body;

    if (body === undefined) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

let deployment: Deployment | undefined;

afterEach(async () => {
  await deployment?.close();
  deployment = undefined;
});

function resultFor(result: Awaited<ReturnType<typeof verifyDeployment>>, path: string) {
  const found = result.results.find((endpoint) => endpoint.path === path);
  assert.ok(found, `no result recorded for ${path}`);
  return found;
}

describe('verifyDeployment', () => {
  it('passes when all three endpoints answer 200 with well-formed bodies', async () => {
    deployment = await startDeployment();

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.results.map((endpoint) => [endpoint.path, endpoint.status, endpoint.ok]),
      [
        ['/api/coverage', 200, true],
        ['/api/totals', 200, true],
        ['/api/assets', 200, true],
      ],
    );
    assert.deepEqual(
      result.results.map((endpoint) => endpoint.detail),
      ['', '', ''],
    );
  });

  it('requests exactly the three endpoints the rotation has to confirm', async () => {
    deployment = await startDeployment();

    await verifyDeployment(deployment.baseUrl);

    assert.deepEqual(deployment.requests, ['/api/coverage', '/api/totals', '/api/assets']);
    assert.deepEqual([...ENDPOINT_PATHS], ['/api/coverage', '/api/totals', '/api/assets']);
  });

  it('fails on the 500 a stale or revoked credential produces, naming the endpoint', async () => {
    // What the route itself returns when the pool cannot reach the database.
    deployment = await startDeployment({
      '/api/coverage': { status: 500, body: { error: 'Could not read ledger coverage.' } },
    });

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(result.ok, false);
    const coverage = resultFor(result, '/api/coverage');
    assert.equal(coverage.ok, false);
    assert.equal(coverage.status, 500);
    assert.match(coverage.detail, /expected 200, got 500/);
    assert.match(coverage.detail, /Could not read ledger coverage/);
  });

  it('checks every endpoint even after one fails, so the diagnosis is complete', async () => {
    deployment = await startDeployment({
      '/api/coverage': { status: 500, body: { error: 'Could not read ledger coverage.' } },
      '/api/assets': { status: 500, body: { error: 'Could not read asset activity.' } },
    });

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(result.results.length, 3);
    assert.deepEqual(deployment.requests, ['/api/coverage', '/api/totals', '/api/assets']);
    assert.deepEqual(
      result.results.map((endpoint) => endpoint.ok),
      [false, true, false],
    );
  });

  it('fails a 200 that reports an empty database — the wrong-database rotation', async () => {
    // A new role pointed at a database that was never migrated into answers 200
    // on every route. Only the counts give it away.
    deployment = await startDeployment({
      '/api/coverage': {
        body: { ledgerCount: 0, minLedger: null, maxLedger: null, latestClosedAt: null },
      },
    });

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(result.ok, false);
    const coverage = resultFor(result, '/api/coverage');
    assert.equal(coverage.status, 200);
    assert.match(coverage.detail, /0 ledgers/);
  });

  it('accepts an empty database under --allow-empty', async () => {
    deployment = await startDeployment({
      '/api/coverage': {
        body: { ledgerCount: 0, minLedger: null, maxLedger: null, latestClosedAt: null },
      },
      '/api/totals': { body: { paymentCount: 0, tradeCount: 0, accountCount: 0 } },
      '/api/assets': { body: { assets: [] } },
    });

    const result = await verifyDeployment(deployment.baseUrl, { allowEmpty: true });

    assert.equal(result.ok, true);
  });

  it('accepts a coverage body whose bounds are null only when the count agrees', async () => {
    deployment = await startDeployment({
      '/api/coverage': {
        body: { ledgerCount: 720, minLedger: null, maxLedger: null, latestClosedAt: null },
      },
    });

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(resultFor(result, '/api/coverage').ok, true);
  });

  it('fails a 200 whose body is not JSON', async () => {
    // A platform error page is served with a 200 often enough to be worth catching.
    deployment = await startDeployment({
      '/api/totals': { body: '<!doctype html><title>Something went wrong</title>' },
    });

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(result.ok, false);
    const totals = resultFor(result, '/api/totals');
    assert.equal(totals.status, 200);
    assert.match(totals.detail, /body is not JSON/);
  });

  it('fails a 200 whose counts are strings rather than numbers', async () => {
    deployment = await startDeployment({
      '/api/totals': { body: { paymentCount: '412', tradeCount: 88, accountCount: 530 } },
    });

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(result.ok, false);
    assert.match(resultFor(result, '/api/totals').detail, /paymentCount is not a number/);
  });

  it('fails when an asset row is missing a contract field, naming the row', async () => {
    deployment = await startDeployment({
      '/api/assets': {
        body: {
          assets: [
            {
              assetCode: 'XLM',
              assetIssuer: null,
              transferCount: 300,
              totalVolume: 1,
              activeDays: 1,
            },
            { assetCode: 'USDC', assetIssuer: 'GA...', transferCount: 10, totalVolume: 2 },
          ],
        },
      },
    });

    const result = await verifyDeployment(deployment.baseUrl);

    assert.equal(result.ok, false);
    assert.match(
      resultFor(result, '/api/assets').detail,
      /assets\[1\]: activeDays is not a number/,
    );
  });

  it('fails without throwing when nothing is listening', async () => {
    // Bind and release a port so the address is real but closed, which is what a
    // deployment that failed to come back up after the redeploy looks like.
    const closed = await startDeployment();
    const { baseUrl } = closed;
    await closed.close();

    const result = await verifyDeployment(baseUrl, { timeoutMs: 2_000 });

    assert.equal(result.ok, false);
    for (const endpoint of result.results) {
      assert.equal(endpoint.status, null, `${endpoint.path} should have no status`);
      assert.notEqual(endpoint.detail, '');
    }
  });

  it('fails on a response that never arrives rather than hanging', async () => {
    const hanging: Server = createServer(() => {
      // Accept the request and answer nothing, which is how an instance stuck on
      // a connection to a database it can no longer authenticate against behaves.
    });
    await new Promise<void>((resolve) => {
      hanging.listen(0, '127.0.0.1', resolve);
    });
    const { port } = hanging.address() as AddressInfo;

    try {
      const result = await verifyDeployment(`http://127.0.0.1:${String(port)}`, {
        timeoutMs: 250,
      });

      assert.equal(result.ok, false);
      assert.equal(result.results.length, 3);
      for (const endpoint of result.results) {
        assert.equal(endpoint.status, null);
      }
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => {
        hanging.close(() => {
          resolve();
        });
      });
    }
  });
});

describe('formatResult', () => {
  it('reports every endpoint and a pass summary', async () => {
    deployment = await startDeployment();

    const text = formatResult(await verifyDeployment(deployment.baseUrl));

    assert.match(text, /PASS {2}GET \/api\/coverage -> 200/);
    assert.match(text, /PASS {2}GET \/api\/totals -> 200/);
    assert.match(text, /PASS {2}GET \/api\/assets -> 200/);
    assert.match(text, /All 3 endpoints OK\./);
  });

  it('reports a failure count and says so when there was no response at all', async () => {
    const closed = await startDeployment();
    const { baseUrl } = closed;
    await closed.close();

    const text = formatResult(await verifyDeployment(baseUrl, { timeoutMs: 2_000 }));

    assert.match(text, /FAIL {2}GET \/api\/coverage -> no response/);
    assert.match(text, /3 of 3 endpoints failed\./);
  });
});

describe('verify-deployment CLI', () => {
  it('exits 0 against a healthy deployment given with --base-url', async () => {
    deployment = await startDeployment();

    const code = await main(['--base-url', deployment.baseUrl], {});

    assert.equal(code, 0);
  });

  it('exits 1 against a deployment whose routes are failing', async () => {
    deployment = await startDeployment({
      '/api/assets': { status: 500, body: { error: 'Could not read asset activity.' } },
    });

    const code = await main(['--base-url', deployment.baseUrl], {});

    assert.equal(code, 1);
  });

  it('takes the deployment from DEPLOYMENT_URL when no flag is given', async () => {
    deployment = await startDeployment();

    const code = await main([], { DEPLOYMENT_URL: deployment.baseUrl });

    assert.equal(code, 0);
    assert.deepEqual(deployment.requests, ['/api/coverage', '/api/totals', '/api/assets']);
  });

  it('prefers --base-url over DEPLOYMENT_URL', async () => {
    deployment = await startDeployment();

    const code = await main(['--base-url', deployment.baseUrl], {
      DEPLOYMENT_URL: 'http://127.0.0.1:1/unused',
    });

    assert.equal(code, 0);
    assert.equal(deployment.requests.length, 3);
  });

  it('passes --allow-empty through to the check', async () => {
    deployment = await startDeployment({
      '/api/coverage': {
        body: { ledgerCount: 0, minLedger: null, maxLedger: null, latestClosedAt: null },
      },
      '/api/totals': { body: { paymentCount: 0, tradeCount: 0, accountCount: 0 } },
      '/api/assets': { body: { assets: [] } },
    });

    assert.equal(await main(['--base-url', deployment.baseUrl], {}), 1);
    assert.equal(await main(['--base-url', deployment.baseUrl, '--allow-empty'], {}), 0);
  });

  it('rejects a bad invocation without making a request', async () => {
    deployment = await startDeployment();

    assert.equal(await main(['--base-url'], {}), 1);
    assert.equal(await main(['--base-url', 'not a url'], {}), 1);
    assert.equal(await main(['--timeout', 'soon', '--base-url', deployment.baseUrl], {}), 1);
    assert.equal(await main(['--timeout', '-5', '--base-url', deployment.baseUrl], {}), 1);
    assert.equal(await main(['--wat'], {}), 1);

    assert.deepEqual(deployment.requests, []);
  });

  it('prints usage and exits 0 for --help', async () => {
    assert.equal(await main(['--help'], {}), 0);
    assert.equal(await main(['-h'], {}), 0);
  });

  it('defaults to the documented deployment URL', () => {
    assert.equal(DEFAULT_BASE_URL, 'https://xlm-flow-indexer.vercel.app');
  });
});
