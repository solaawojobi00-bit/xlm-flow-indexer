import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import {
  DEFAULT_CONFIRMATION_LAG,
  DEFAULT_MAX_LEDGERS_PER_PASS,
  ingestIncrementalPass,
  nextRange,
  poll,
} from '../../src/ingest/incremental.ts';
import { ingestPayments } from '../../src/ingest/payments.ts';
import {
  INGEST_JOBS,
  allIngestState,
  isIngestJob,
  lastIngestedLedger,
  recordIngestedLedger,
} from '../../src/ingest/state.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

/**
 * Incremental ingestion suite (issue #52).
 *
 * Split deliberately in two. The range arithmetic — resuming, clamping to the
 * confirmation lag, capping a pass, refusing to start without a watermark — is
 * the part with all the edge cases, and `nextRange` is pure so it is tested
 * directly with no Horizon and no database. The rest drives the real jobs
 * against recorded fixtures to prove the delta path writes what the full-range
 * path writes, and that issue #6's idempotency still holds under it.
 */

const paymentsWide = loadFixture('testnet-payments-4539840-4539872');
const paymentsNarrow = loadFixture('testnet-payments-4539850-4539862');

let wideServer: FixtureServer;
let narrowServer: FixtureServer;

before(async () => {
  [wideServer, narrowServer] = await Promise.all([
    startFixtureServer(paymentsWide),
    startFixtureServer(paymentsNarrow),
  ]);
});

after(async () => {
  await Promise.all([wideServer.close(), narrowServer.close()]);
});

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function counts(db: Db): Record<string, number> {
  const tables = ['ledgers', 'accounts', 'operations', 'payments'] as const;
  const out: Record<string, number> = {};
  for (const t of tables) {
    out[t] = (db.prepare(`SELECT COUNT(*) v FROM ${t}`).get() as { v: number }).v;
  }
  return out;
}

/**
 * A HorizonClient whose chain head is fixed, pointed at a fixture server.
 *
 * The fixtures are recorded ranges, so a real `/ledgers?order=desc` call has no
 * recorded response. Overriding just the head keeps every other request going
 * through the real client and the real fixture transport.
 */
function clientWithHead(server: FixtureServer, head: number): HorizonClient {
  const client = new HorizonClient({ baseUrl: server.baseUrl });
  Object.defineProperty(client, 'latestLedger', {
    value: () => Promise.resolve(head),
    writable: true,
  });
  return client;
}

describe('nextRange', () => {
  it('starts at the given start ledger when there is no watermark', () => {
    assert.deepEqual(nextRange(undefined, 1000, { startLedger: 100 }), {
      fromLedger: 100,
      toLedger: 299,
    });
  });

  it('refuses to start without a watermark or an explicit start', () => {
    // The alternative would be defaulting to the chain head, which silently
    // skips all history and looks like it worked.
    assert.throws(
      () => nextRange(undefined, 1000),
      /No recorded watermark for this job and no startLedger given/,
    );
  });

  it('resumes at the ledger after the watermark', () => {
    const range = nextRange(500, 1000, { maxLedgersPerPass: 10 });
    assert.deepEqual(range, { fromLedger: 501, toLedger: 510 });
  });

  it('stops short of the head by the confirmation lag', () => {
    // Head 1000 with the default lag of 5 means 995 is the newest trustworthy
    // ledger, so a watermark at 994 yields exactly one ledger.
    assert.deepEqual(nextRange(994, 1000), { fromLedger: 995, toLedger: 995 });
    assert.equal(DEFAULT_CONFIRMATION_LAG, 5);
  });

  it('returns undefined when everything trustworthy is already processed', () => {
    assert.equal(nextRange(995, 1000), undefined);
    assert.equal(nextRange(1000, 1000), undefined, 'a watermark at the head is also up to date');
  });

  it('never proposes a range inside the confirmation lag', () => {
    // The regression that would reintroduce silent gaps: advancing into ledgers
    // Horizon may not have fully indexed, which the monotonic watermark would
    // then never revisit.
    for (let watermark = 990; watermark <= 1000; watermark += 1) {
      const range = nextRange(watermark, 1000, { confirmationLag: 5 });
      if (range) {
        assert.ok(range.toLedger <= 995, `proposed ${String(range.toLedger)} inside the lag`);
      }
    }
  });

  it('caps a pass at maxLedgersPerPass', () => {
    const range = nextRange(0, 100_000, { maxLedgersPerPass: 50 });
    assert.deepEqual(range, { fromLedger: 1, toLedger: 50 });
    assert.equal(DEFAULT_MAX_LEDGERS_PER_PASS, 200);
  });

  it('walks forward over successive passes until drained', () => {
    // Proves the cap is a batch size and not a ceiling: a large backlog is
    // consumed by repeated ticks rather than needing one huge pass.
    let watermark: number | undefined = 0;
    const head = 1000;
    const ranges = [];

    for (;;) {
      const range = nextRange(watermark, head, { maxLedgersPerPass: 400, confirmationLag: 5 });
      if (!range) break;
      ranges.push(range);
      watermark = range.toLedger;
    }

    assert.deepEqual(ranges, [
      { fromLedger: 1, toLedger: 400 },
      { fromLedger: 401, toLedger: 800 },
      { fromLedger: 801, toLedger: 995 },
    ]);
    // Contiguous and gapless, which is the property that matters.
    assert.equal(ranges[0]?.toLedger, (ranges[1]?.fromLedger ?? 0) - 1);
    assert.equal(ranges[1]?.toLedger, (ranges[2]?.fromLedger ?? 0) - 1);
  });

  it('treats a zero watermark as "resume at 1", not "no watermark"', () => {
    assert.deepEqual(nextRange(0, 1000, { maxLedgersPerPass: 5 }), {
      fromLedger: 1,
      toLedger: 5,
    });
  });

  it('allows a zero confirmation lag', () => {
    assert.deepEqual(nextRange(999, 1000, { confirmationLag: 0 }), {
      fromLedger: 1000,
      toLedger: 1000,
    });
  });

  it('rejects nonsensical options', () => {
    assert.throws(() => nextRange(1, 100, { confirmationLag: -1 }), /non-negative integer/);
    assert.throws(() => nextRange(1, 100, { maxLedgersPerPass: 0 }), /positive integer/);
    assert.throws(() => nextRange(undefined, 100, { startLedger: 0 }), /positive integer/);
  });
});

describe('ingest_state', () => {
  it('reports no watermark for a job that has never run', () => {
    const db = freshDb();
    assert.equal(lastIngestedLedger(db, 'payments'), undefined);
    assert.deepEqual(allIngestState(db), []);
  });

  it('records and reads back a watermark per job', () => {
    const db = freshDb();
    recordIngestedLedger(db, 'payments', 100);
    recordIngestedLedger(db, 'trades', 250);

    assert.equal(lastIngestedLedger(db, 'payments'), 100);
    assert.equal(lastIngestedLedger(db, 'trades'), 250);
    assert.equal(lastIngestedLedger(db, 'trustlines'), undefined, 'jobs are independent');
  });

  it('only ever moves a watermark forward', () => {
    // Monotonicity is enforced in SQL rather than by the caller, so an
    // out-of-order or replayed pass cannot rewind progress and make the poll
    // loop re-read the same ledgers forever.
    const db = freshDb();
    recordIngestedLedger(db, 'payments', 500);
    recordIngestedLedger(db, 'payments', 100);

    assert.equal(lastIngestedLedger(db, 'payments'), 500);
  });

  it('rejects a negative watermark', () => {
    const db = freshDb();
    assert.throws(() => recordIngestedLedger(db, 'payments', -1), /non-negative integer/);
  });

  it('rejects an unknown job at the schema level', () => {
    // The CHECK constraint is the backstop for the TypeScript union, which says
    // nothing at runtime about a value read from a config file or CLI flag.
    const db = freshDb();
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO ingest_state (job, last_ledger, updated_at) VALUES (?, ?, ?)')
          .run('nonsense', 1, '2026-01-01T00:00:00Z'),
      /CHECK constraint failed/,
    );
  });

  it('agrees with isIngestJob about which jobs exist', () => {
    assert.deepEqual([...INGEST_JOBS], ['payments', 'trustlines', 'trades']);
    assert.ok(isIngestJob('payments'));
    assert.ok(!isIngestJob('nonsense'));
  });
});

describe('incremental passes against recorded data', () => {
  /**
   * The wide fixture covers ledgers 4539840..4539872 and carries 16 payment
   * operations across 33 ledgers. A head of 4539877 with the default lag of 5
   * makes 4539872 the newest trustworthy ledger — exactly the fixture's end —
   * so a single pass can cover the whole capture.
   */
  const WIDE_FROM = 4539840;
  const WIDE_TO = 4539872;
  const HEAD = WIDE_TO + DEFAULT_CONFIRMATION_LAG;

  it('ingests a delta and advances the watermark', async () => {
    const db = freshDb();
    const client = clientWithHead(wideServer, HEAD);

    const result = await ingestIncrementalPass(db, client, 'payments', {
      startLedger: WIDE_FROM,
    });

    assert.deepEqual(result.range, { fromLedger: WIDE_FROM, toLedger: WIDE_TO });
    assert.equal(result.latestLedger, HEAD);
    assert.equal(result.lastLedger, WIDE_TO);
    assert.equal(lastIngestedLedger(db, 'payments'), WIDE_TO);
    assert.deepEqual(counts(db), { ledgers: 33, accounts: 4, operations: 16, payments: 16 });
  });

  it('is a no-op once caught up', async () => {
    const db = freshDb();
    const client = clientWithHead(wideServer, HEAD);

    await ingestIncrementalPass(db, client, 'payments', { startLedger: WIDE_FROM });
    const before = counts(db);

    const second = await ingestIncrementalPass(db, client, 'payments', {
      startLedger: WIDE_FROM,
    });

    assert.equal(second.range, undefined, 'nothing new to do');
    assert.deepEqual(counts(db), before);
    assert.equal(lastIngestedLedger(db, 'payments'), WIDE_TO);
  });

  it('does not advance the watermark when ingestion throws', async () => {
    // The watermark is written only after the ingestion call returns, so a
    // failed pass is retried in full rather than skipped. Without this the
    // monotonic watermark would step over records that were never read.
    const db = freshDb();
    const client = clientWithHead(wideServer, HEAD);
    Object.defineProperty(client, 'operations', {
      value: () => {
        throw new Error('horizon exploded');
      },
      writable: true,
    });

    await assert.rejects(
      () => ingestIncrementalPass(db, client, 'payments', { startLedger: WIDE_FROM }),
      /horizon exploded/,
    );
    assert.equal(lastIngestedLedger(db, 'payments'), undefined, 'watermark must not move');
  });

  it('reaches the same state as a single full-range ingest', async () => {
    // The claim that a delta pass is "just another range" through the same code
    // path, asserted rather than assumed.
    const incremental = freshDb();
    await ingestIncrementalPass(incremental, clientWithHead(wideServer, HEAD), 'payments', {
      startLedger: WIDE_FROM,
    });

    const fullRange = freshDb();
    await ingestPayments(fullRange, new HorizonClient({ baseUrl: wideServer.baseUrl }), {
      fromLedger: WIDE_FROM,
      toLedger: WIDE_TO,
    });

    assert.deepEqual(counts(incremental), counts(fullRange));
    assert.deepEqual(
      incremental.prepare('SELECT * FROM payments ORDER BY operation_id').all(),
      fullRange.prepare('SELECT * FROM payments ORDER BY operation_id').all(),
    );
  });
});

describe('idempotency holds under incremental mode', () => {
  /**
   * The regression issue #52 asks for by name: run incremental ingestion twice
   * over an overlapping range and assert zero duplicates.
   *
   * The overlap is forced by rewinding nothing and instead seeding the watermark
   * *behind* ground already covered — the situation a crash-and-retry produces,
   * where a pass re-reads ledgers whose rows are already present.
   */
  const NARROW_FROM = 4539850;
  const NARROW_TO = 4539862;

  it('writes no duplicates when a pass re-covers ingested ledgers', async () => {
    const db = freshDb();
    const client = clientWithHead(narrowServer, NARROW_TO + DEFAULT_CONFIRMATION_LAG);

    const first = await ingestIncrementalPass(db, client, 'payments', {
      startLedger: NARROW_FROM,
    });
    assert.deepEqual(first.range, { fromLedger: NARROW_FROM, toLedger: NARROW_TO });
    const afterFirst = counts(db);
    assert.deepEqual(afterFirst, { ledgers: 13, accounts: 4, operations: 8, payments: 8 });

    // Force the overlap: pretend the watermark never advanced past the start,
    // exactly as it would look after a crash between the write and the record.
    db.prepare('DELETE FROM ingest_state WHERE job = ?').run('payments');

    const second = await ingestIncrementalPass(db, client, 'payments', {
      startLedger: NARROW_FROM,
    });

    assert.deepEqual(
      second.range,
      { fromLedger: NARROW_FROM, toLedger: NARROW_TO },
      'the same range must be re-proposed',
    );
    assert.deepEqual(counts(db), afterFirst, 're-covering a range must write nothing new');

    for (const [table, key] of [
      ['ledgers', 'sequence'],
      ['accounts', 'account_id'],
      ['operations', 'id'],
      ['payments', 'operation_id'],
    ] as const) {
      const dupes = db
        .prepare(`SELECT ${key} FROM ${table} GROUP BY ${key} HAVING COUNT(*) > 1`)
        .all();
      assert.deepEqual(dupes, [], `${table} must hold no duplicate ${key}`);
    }

    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });

  it('writes no duplicates across overlapping passes of different widths', async () => {
    // The narrow range sits inside the wide one, so the second pass re-reads
    // every ledger of the first and adds the 20 that are genuinely new.
    const db = freshDb();

    await ingestIncrementalPass(
      db,
      clientWithHead(narrowServer, NARROW_TO + DEFAULT_CONFIRMATION_LAG),
      'payments',
      { startLedger: NARROW_FROM },
    );
    assert.deepEqual(counts(db), { ledgers: 13, accounts: 4, operations: 8, payments: 8 });

    db.prepare('DELETE FROM ingest_state WHERE job = ?').run('payments');

    await ingestIncrementalPass(
      db,
      clientWithHead(wideServer, 4539872 + DEFAULT_CONFIRMATION_LAG),
      'payments',
      { startLedger: 4539840 },
    );

    assert.deepEqual(counts(db), { ledgers: 33, accounts: 4, operations: 16, payments: 16 });
    const dupes = db
      .prepare('SELECT operation_id FROM payments GROUP BY operation_id HAVING COUNT(*) > 1')
      .all();
    assert.deepEqual(dupes, []);
  });
});

describe('poll', () => {
  const HEAD = 4539872 + DEFAULT_CONFIRMATION_LAG;

  it('runs a single tick and stops', async () => {
    const db = freshDb();
    const seen: string[] = [];

    const results = await poll(db, clientWithHead(wideServer, HEAD), {
      jobs: ['payments'],
      intervalSeconds: 30,
      maxTicks: 1,
      startLedger: 4539840,
      onPass: (r) => seen.push(`${r.job}:${String(r.range?.toLedger ?? 'none')}`),
      // Nothing should wait: with maxTicks 1 the loop must exit before sleeping.
      sleep: () => Promise.reject(new Error('poll must not sleep on its final tick')),
    });

    assert.equal(results.length, 1);
    assert.deepEqual(seen, ['payments:4539872']);
    assert.equal(lastIngestedLedger(db, 'payments'), 4539872);
  });

  it('sleeps between ticks but not after the last', async () => {
    /**
     * Driven over already-caught-up ticks rather than a real backlog.
     *
     * A multi-tick drain cannot be replayed from these captures: the fixture
     * server keys responses on the exact request path, and each pass derives a
     * different cursor from its own `fromLedger`, so only the cursor for the
     * capture's own start is recorded. Splitting the wide range into 15-ledger
     * passes asks for cursors that were never captured and gets a 404.
     *
     * The drain arithmetic is covered instead by `nextRange`'s "walks forward
     * over successive passes until drained" case above, which proves the passes
     * are contiguous, gapless and cap-respecting without needing Horizon at
     * all. What is left for this test is the loop's own timing behaviour.
     */
    const db = freshDb();
    recordIngestedLedger(db, 'payments', 4539872);
    let slept = 0;

    const results = await poll(db, clientWithHead(wideServer, HEAD), {
      jobs: ['payments'],
      intervalSeconds: 30,
      maxTicks: 3,
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });

    assert.equal(results.length, 3, 'one pass per tick');
    assert.ok(
      results.every((r) => r.range === undefined),
      'every tick is a no-op, since the watermark is already at the safe head',
    );
    assert.equal(slept, 2, 'sleeps between ticks, not after the last');
    assert.equal(lastIngestedLedger(db, 'payments'), 4539872, 'watermark unmoved');
  });

  it('stops when the signal is aborted', async () => {
    const db = freshDb();
    const controller = new AbortController();

    const results = await poll(db, clientWithHead(wideServer, HEAD), {
      jobs: ['payments'],
      intervalSeconds: 30,
      startLedger: 4539840,
      maxLedgersPerPass: 5,
      signal: controller.signal,
      // Abort during the wait, so the loop exits rather than running forever.
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    assert.equal(results.length, 1, 'one tick ran before the abort took effect');
    assert.equal(lastIngestedLedger(db, 'payments'), 4539844);
  });

  it('lets sibling jobs finish their tick when one fails', async () => {
    // Watermarks are per job so that partial progress is expressible. This is
    // the case that makes that matter: payments must still commit even though
    // trustlines blows up in the same tick.
    const db = freshDb();
    const client = clientWithHead(wideServer, HEAD);
    Object.defineProperty(client, 'effects', {
      value: () => {
        throw new Error('effects unavailable');
      },
      writable: true,
    });

    await assert.rejects(
      () =>
        poll(db, client, {
          jobs: ['payments', 'trustlines'],
          intervalSeconds: 30,
          maxTicks: 1,
          startLedger: 4539840,
          sleep: () => Promise.resolve(),
        }),
      /effects unavailable/,
    );

    assert.equal(lastIngestedLedger(db, 'payments'), 4539872, 'payments still committed');
    assert.equal(lastIngestedLedger(db, 'trustlines'), undefined, 'trustlines made no progress');
  });
});
