import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { HorizonClient, parseRetryAfter } from '../../src/horizon/client.ts';
import {
  HorizonHttpError,
  HorizonRetryLimitError,
  HorizonTimeoutError,
} from '../../src/horizon/errors.ts';
import type { HorizonRecord } from '../../src/horizon/types.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** Start a real HTTP server on an ephemeral port and return its base URL. */
async function startServer(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

function page(records: { id: string; paging_token: string }[], next?: string): string {
  return JSON.stringify({
    _links: next === undefined ? {} : { next: { href: next } },
    _embedded: { records },
  });
}

function rec(n: number): { id: string; paging_token: string } {
  return { id: `op${String(n)}`, paging_token: String(n) };
}

/** A client whose waiting is instant and whose jitter is fixed, so tests are fast. */
function testClient(baseUrl: string, overrides = {}): HorizonClient {
  const slept: number[] = [];
  const client = new HorizonClient({
    baseUrl,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    random: () => 1, // full jitter at its maximum, making backoff deterministic
    ...overrides,
  });
  Object.defineProperty(client, 'slept', { value: slept });
  return client;
}

function sleptOf(client: HorizonClient): number[] {
  return (client as unknown as { slept: number[] }).slept;
}

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    assert.equal(parseRetryAfter('3', 0), 3000);
  });

  it('reads an HTTP date as a delay from now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 5000);
  });

  it('clamps a past date to zero rather than returning a negative wait', () => {
    const now = Date.parse('2026-01-01T00:00:10Z');
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now), 0);
  });

  it('returns undefined when absent or unparseable, so backoff takes over', () => {
    assert.equal(parseRetryAfter(null, 0), undefined);
    assert.equal(parseRetryAfter('', 0), undefined);
    assert.equal(parseRetryAfter('soon please', 0), undefined);
  });
});

describe('paging', () => {
  it('follows cursors across pages and stops on the empty page', async () => {
    let requests = 0;
    const base = await startServer((req, res) => {
      requests += 1;
      const cursor = new URL(req.url ?? '', 'http://x').searchParams.get('cursor');
      res.setHeader('content-type', 'application/json');
      if (cursor === null) res.end(page([rec(1), rec(2)]));
      else if (cursor === '2') res.end(page([rec(3)]));
      else res.end(page([]));
    });

    const client = testClient(base);
    const ids: string[] = [];
    for await (const record of client.paginate<HorizonRecord>('/operations')) {
      ids.push(record.id);
    }

    assert.deepEqual(ids, ['op1', 'op2', 'op3']);
    assert.equal(requests, 3, 'should stop after the empty page, not keep asking');
  });

  it('terminates even when Horizon sends a next link on an empty final page', async () => {
    // This is the live-endpoint behaviour: Horizon always supplies a next link, so a
    // client that trusts the link instead of the record count never stops.
    let requests = 0;
    const base = await startServer((req, res) => {
      requests += 1;
      const cursor = new URL(req.url ?? '', 'http://x').searchParams.get('cursor');
      res.setHeader('content-type', 'application/json');
      if (cursor === null) res.end(page([rec(1)], 'http://example/next'));
      else res.end(page([], 'http://example/next'));
    });

    const client = testClient(base);
    const ids: string[] = [];
    for await (const record of client.paginate<HorizonRecord>('/operations')) {
      ids.push(record.id);
    }

    assert.deepEqual(ids, ['op1']);
    assert.equal(requests, 2);
  });

  it('resumes from a supplied cursor', async () => {
    const seen: (string | null)[] = [];
    const base = await startServer((req, res) => {
      const cursor = new URL(req.url ?? '', 'http://x').searchParams.get('cursor');
      seen.push(cursor);
      res.setHeader('content-type', 'application/json');
      res.end(cursor === '100' ? page([rec(101)]) : page([]));
    });

    const client = testClient(base);
    const ids: string[] = [];
    for await (const record of client.paginate<HorizonRecord>('/operations', { cursor: '100' })) {
      ids.push(record.id);
    }

    assert.deepEqual(ids, ['op101']);
    assert.equal(seen[0], '100', 'first request must carry the supplied cursor');
  });

  it('stops if the cursor fails to advance, rather than looping', async () => {
    // Defensive: a Horizon returning the same paging_token forever would otherwise
    // spin indefinitely, which in CI looks like a hang rather than a failure.
    let requests = 0;
    const base = await startServer((_req, res) => {
      requests += 1;
      res.setHeader('content-type', 'application/json');
      res.end(page([rec(7)]));
    });

    const client = testClient(base);
    const ids: string[] = [];
    for await (const record of client.paginate<HorizonRecord>('/operations')) {
      ids.push(record.id);
    }

    assert.deepEqual(ids, ['op7', 'op7']);
    assert.equal(requests, 2, 'second identical cursor must end iteration');
  });

  it('passes through query parameters', async () => {
    let url = '';
    const base = await startServer((req, res) => {
      url = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(page([]));
    });

    const client = testClient(base);
    for await (const _ of client.paginate<HorizonRecord>('/operations', {
      limit: 200,
      order: 'asc',
    })) {
      // no records expected
    }

    assert.match(url, /limit=200/);
    assert.match(url, /order=asc/);
  });
});

describe('retry behaviour', () => {
  it('retries a 429 and honours Retry-After over computed backoff', async () => {
    let attempts = 0;
    const base = await startServer((_req, res) => {
      attempts += 1;
      res.setHeader('content-type', 'application/json');
      if (attempts === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '2');
        res.end('{"title":"Rate limit exceeded"}');
        return;
      }
      res.end(page([rec(1)]));
    });

    const client = testClient(base);
    const result = await client.getPage<HorizonRecord>('/operations');

    assert.equal(result._embedded.records.length, 1);
    assert.equal(attempts, 2);
    assert.deepEqual(sleptOf(client), [2000], 'Retry-After of 2s must win over backoff');
  });

  it('retries 5xx with exponential backoff', async () => {
    let attempts = 0;
    const base = await startServer((_req, res) => {
      attempts += 1;
      res.setHeader('content-type', 'application/json');
      if (attempts <= 3) {
        res.statusCode = 503;
        res.end('{"title":"Service unavailable"}');
        return;
      }
      res.end(page([rec(1)]));
    });

    const client = testClient(base, { baseDelayMs: 100 });
    await client.getPage<HorizonRecord>('/operations');

    assert.equal(attempts, 4);
    // random() is pinned to 1, so full jitter yields the full capped exponential.
    assert.deepEqual(sleptOf(client), [100, 200, 400]);
  });

  it('caps a single backoff wait at maxDelayMs', async () => {
    let attempts = 0;
    const base = await startServer((_req, res) => {
      attempts += 1;
      res.setHeader('content-type', 'application/json');
      if (attempts <= 4) {
        res.statusCode = 500;
        res.end('');
        return;
      }
      res.end(page([rec(1)]));
    });

    const client = testClient(base, { baseDelayMs: 1000, maxDelayMs: 2500 });
    await client.getPage<HorizonRecord>('/operations');

    assert.deepEqual(sleptOf(client), [1000, 2000, 2500, 2500]);
  });

  it('fails fast on a 4xx that is not 429', async () => {
    let attempts = 0;
    const base = await startServer((_req, res) => {
      attempts += 1;
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end('{"title":"Bad Request","detail":"invalid cursor"}');
    });

    const client = testClient(base);
    await assert.rejects(
      () => client.getPage<HorizonRecord>('/operations'),
      (error: unknown) => {
        assert.ok(error instanceof HorizonHttpError);
        assert.equal(error.status, 400);
        assert.match(error.body, /invalid cursor/);
        return true;
      },
    );

    assert.equal(attempts, 1, 'a 400 must not be retried');
    assert.deepEqual(sleptOf(client), []);
  });

  it('gives up after maxRetries and reports the attempt count', async () => {
    let attempts = 0;
    const base = await startServer((_req, res) => {
      attempts += 1;
      res.statusCode = 503;
      res.end('');
    });

    const client = testClient(base, { maxRetries: 2 });
    await assert.rejects(
      () => client.getPage<HorizonRecord>('/operations'),
      (error: unknown) => {
        assert.ok(error instanceof HorizonRetryLimitError);
        assert.equal(error.attempts, 3);
        assert.ok(error.cause instanceof HorizonHttpError);
        return true;
      },
    );

    assert.equal(attempts, 3, 'initial attempt plus two retries');
  });

  it('stops at the overall deadline rather than using every retry', async () => {
    const base = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end('');
    });

    // A clock that jumps 60s per reading exhausts a 120s budget almost immediately,
    // proving the deadline is enforced independently of the retry count.
    let clock = 0;
    const client = testClient(base, {
      maxRetries: 50,
      totalTimeoutMs: 120_000,
      now: () => {
        clock += 60_000;
        return clock;
      },
    });

    await assert.rejects(
      () => client.getPage<HorizonRecord>('/operations'),
      (error: unknown) => {
        assert.ok(error instanceof HorizonTimeoutError);
        return true;
      },
    );
  });
});

describe('client configuration', () => {
  it('strips trailing slashes from the base URL', async () => {
    let path = '';
    const base = await startServer((req, res) => {
      path = (req.url ?? '').split('?')[0] ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(page([]));
    });

    const client = testClient(`${base}///`);
    await client.getPage<HorizonRecord>('/operations');

    assert.equal(path, '/operations', 'must not produce a doubled slash');
  });

  it('exposes the three Phase 1 endpoints', async () => {
    const paths: string[] = [];
    const base = await startServer((req, res) => {
      paths.push((req.url ?? '').split('?')[0] ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(page([]));
    });

    const client = testClient(base);
    for await (const _ of client.operations()) break;
    for await (const _ of client.effects()) break;
    for await (const _ of client.trades()) break;

    assert.deepEqual(paths, ['/operations', '/effects', '/trades']);
  });
});
