import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export interface Fixture {
  readonly job: string;
  readonly capturedAt: string;
  readonly horizonUrl: string;
  readonly networkPassphrase: string;
  readonly horizonVersion: string;
  readonly fromLedger: number;
  readonly toLedger: number;
  readonly responses: Record<string, unknown>;
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, name, 'horizon.json'), 'utf8')) as Fixture;
}

export interface FixtureServer {
  readonly baseUrl: string;
  /** Request paths served so far, in order — lets a test assert what was asked for. */
  readonly requests: string[];
  close(): Promise<void>;
}

/**
 * Serve recorded Horizon responses over real HTTP.
 *
 * Replaying through an actual socket rather than by stubbing `fetch` keeps the client's
 * transport, header and status handling in the code path under test. The data is
 * Horizon's own, recorded by scripts/capture-fixtures.ts; only the network hop is local.
 *
 * A request with no recorded response returns 404 rather than an empty page. An empty
 * page would look like a legitimate end-of-range and quietly truncate the ingestion,
 * turning a missing fixture into a passing test that verifies nothing.
 */
export async function startFixtureServer(fixture: Fixture): Promise<FixtureServer> {
  const requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const key = req.url ?? '';
    requests.push(key);

    const body = fixture.responses[key];
    if (body === undefined) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ title: 'No recorded fixture for this request', key }));
      return;
    }

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
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
