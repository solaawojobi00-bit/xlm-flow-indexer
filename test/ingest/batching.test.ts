import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { RunResult, SqlAdapter, SqlParam } from '../../src/db/adapter.ts';
import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { sqliteAdapter } from '../../src/db/sqlite-adapter.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { batchesWithin, batchSizeOf, DEFAULT_BATCH_RECORDS } from '../../src/ingest/batch.ts';
import type { LedgerRange } from '../../src/ingest/payments.ts';
import { ingestPayments } from '../../src/ingest/payments.ts';
import { ingestTrades } from '../../src/ingest/trades.ts';
import { ingestTrustlines } from '../../src/ingest/trustlines.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

/**
 * Bounded write batching (issue #68).
 *
 * The jobs used to autocommit every insert. They now commit a batch of records at a
 * time, which is a behaviour change rather than an optimisation: it alters what a
 * concurrent reader sees mid-pass, and what survives a failure. The existing suites
 * prove the *outcome* of a successful pass is unchanged — every count they assert
 * still holds, unmodified. This file covers the three things they cannot see:
 *
 * 1. that the commits really are bounded, and bounded by record count rather than by
 *    the size of the pass;
 * 2. that a batch which fails rolls back whole, leaving no half-written record;
 * 3. that issue #6's idempotency still carries a re-run over the range that failed.
 */

const paymentsNarrow = loadFixture('testnet-payments-4539850-4539862');
const paymentsWide = loadFixture('testnet-payments-4539840-4539872');
const trustlinesFixture = loadFixture('testnet-trustlines-4540630-4540680');
const tradesFixture = loadFixture('testnet-trades-4534150-4534300');

let narrowServer: FixtureServer;
let wideServer: FixtureServer;
let trustlinesServer: FixtureServer;
let tradesServer: FixtureServer;

before(async () => {
  [narrowServer, wideServer, trustlinesServer, tradesServer] = await Promise.all([
    startFixtureServer(paymentsNarrow),
    startFixtureServer(paymentsWide),
    startFixtureServer(trustlinesFixture),
    startFixtureServer(tradesFixture),
  ]);
});

after(async () => {
  await Promise.all([
    narrowServer.close(),
    wideServer.close(),
    trustlinesServer.close(),
    tradesServer.close(),
  ]);
});

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function clientFor(server: FixtureServer): HorizonClient {
  return new HorizonClient({ baseUrl: server.baseUrl });
}

const NARROW: LedgerRange = {
  fromLedger: paymentsNarrow.fromLedger,
  toLedger: paymentsNarrow.toLedger,
};
const WIDE: LedgerRange = { fromLedger: paymentsWide.fromLedger, toLedger: paymentsWide.toLedger };
const TRUSTLINES: LedgerRange = {
  fromLedger: trustlinesFixture.fromLedger,
  toLedger: trustlinesFixture.toLedger,
};
const TRADES: LedgerRange = {
  fromLedger: tradesFixture.fromLedger,
  toLedger: tradesFixture.toLedger,
};

interface AdapterStats {
  /** Every statement executed through `run`, in order, as SQL text. */
  readonly sqls: string[];
  /** Number of transactions opened. */
  transactions: number;
  /** `run` calls made inside each transaction, in the order the transactions opened. */
  readonly runsPerTransaction: number[];
}

interface ObservedAdapter {
  readonly adapter: SqlAdapter;
  readonly stats: AdapterStats;
}

/**
 * An `SqlAdapter` that records how its writes were grouped, and can fail one of them.
 *
 * Observing at the adapter is what makes "the commits are bounded" testable at all:
 * batching is invisible in the resulting rows, so the only evidence is the shape of the
 * calls the job made. `failOnRun` is 1-based over `run` calls and rejects *before*
 * delegating, so the statement never reaches SQLite — modelling a write that fails
 * rather than one that succeeds and is then rolled back. The transaction it sits in is
 * rolled back by the adapter under test either way, which is the point.
 */
function observe(db: Db, failOnRun?: number): ObservedAdapter {
  const inner = sqliteAdapter(db);
  const stats: AdapterStats = { sqls: [], transactions: 0, runsPerTransaction: [] };

  function wrap(target: SqlAdapter): SqlAdapter {
    return {
      dialect: target.dialect,

      run(sql: string, params?: readonly SqlParam[]): Promise<RunResult> {
        stats.sqls.push(sql);
        if (failOnRun !== undefined && stats.sqls.length === failOnRun) {
          return Promise.reject(new Error(`injected failure on run #${String(failOnRun)}`));
        }
        return target.run(sql, params);
      },

      get<T>(sql: string, params?: readonly SqlParam[]): Promise<T | undefined> {
        return target.get<T>(sql, params);
      },

      all<T>(sql: string, params?: readonly SqlParam[]): Promise<T[]> {
        return target.all<T>(sql, params);
      },

      async transaction<T>(fn: (tx: SqlAdapter) => Promise<T>): Promise<T> {
        stats.transactions += 1;
        const before = stats.sqls.length;
        try {
          return await target.transaction((tx) => fn(wrap(tx)));
        } finally {
          stats.runsPerTransaction.push(stats.sqls.length - before);
        }
      },

      close(): Promise<void> {
        return target.close();
      },
    };
  }

  return { adapter: wrap(inner), stats };
}

const TABLES = ['ledgers', 'accounts', 'operations', 'payments', 'trustlines', 'trades'] as const;

const ORDER_BY: Record<(typeof TABLES)[number], string> = {
  ledgers: 'sequence',
  accounts: 'account_id',
  operations: 'id',
  payments: 'operation_id',
  trustlines: 'account_id, asset_code, asset_issuer',
  trades: 'id',
};

function snapshot(db: Db): string {
  const state: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    state[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${ORDER_BY[table]}`).all();
  }
  return JSON.stringify(state);
}

function countOf(db: Db, table: (typeof TABLES)[number]): number {
  return (db.prepare(`SELECT COUNT(*) v FROM ${table}`).get() as { v: number }).v;
}

describe('batchSizeOf', () => {
  it('defaults to DEFAULT_BATCH_RECORDS', () => {
    assert.equal(batchSizeOf(undefined), DEFAULT_BATCH_RECORDS);
    assert.equal(batchSizeOf({}), DEFAULT_BATCH_RECORDS);
    assert.equal(batchSizeOf({ batchSize: undefined }), DEFAULT_BATCH_RECORDS);
  });

  it('accepts an explicit positive integer', () => {
    assert.equal(batchSizeOf({ batchSize: 1 }), 1);
    assert.equal(batchSizeOf({ batchSize: 5000 }), 5000);
  });

  it('rejects a size that would make batching meaningless', () => {
    // 0 would yield a batch per record *and* never flush; a fraction would make the
    // `>=` comparison in batchesWithin depend on rounding. Both are caller mistakes
    // worth failing loudly rather than absorbing.
    for (const batchSize of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => batchSizeOf({ batchSize }), RangeError, `batchSize ${String(batchSize)}`);
    }
  });
});

describe('batchesWithin', () => {
  /**
   * A stand-in for a job's record stream, recording what was pulled out of it.
   *
   * The `await` is not ceremony: the real sources are Horizon pages fetched over
   * the network, so each record arrives on a later tick. Yielding synchronously
   * would let a consumer that over-pulls still look correct here.
   */
  async function* from<T>(items: readonly T[], pulled: T[]): AsyncGenerator<T> {
    for (const item of items) {
      await Promise.resolve();
      pulled.push(item);
      yield item;
    }
  }

  const always = (): boolean => true;

  it('groups records into batches of the requested size', async () => {
    const pulled: number[] = [];
    const batches: number[][] = [];
    for await (const batch of batchesWithin(from([1, 2, 3, 4, 5, 6], pulled), always, 2)) {
      batches.push(batch);
    }
    assert.deepEqual(batches, [
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('yields a final partial batch', async () => {
    const batches: number[][] = [];
    for await (const batch of batchesWithin(from([1, 2, 3, 4, 5], []), always, 2)) {
      batches.push(batch);
    }
    assert.deepEqual(batches, [[1, 2], [3, 4], [5]]);
  });

  it('yields nothing at all for an empty source', async () => {
    // A job with nothing to do must open no transaction, rather than an empty one.
    const batches: number[][] = [];
    for await (const batch of batchesWithin(from([], []), always, 2)) {
      batches.push(batch);
    }
    assert.deepEqual(batches, []);
  });

  it('stops pulling from the source at the first out-of-range record', async () => {
    // The `break` this replaced ended the job's loop *and* the paging behind it. If
    // batching kept consuming, Horizon would be asked for a page past the end of the
    // range on every pass.
    const pulled: number[] = [];
    const batches: number[][] = [];
    for await (const batch of batchesWithin(from([1, 2, 3, 4, 5, 6], pulled), (n) => n <= 3, 10)) {
      batches.push(batch);
    }

    assert.deepEqual(batches, [[1, 2, 3]]);
    assert.deepEqual(pulled, [1, 2, 3, 4], 'exactly one record past the range, to discover it');
  });

  it('drops an out-of-range record that falls mid-batch', async () => {
    const batches: number[][] = [];
    for await (const batch of batchesWithin(from([1, 2, 3, 4, 5], []), (n) => n <= 3, 2)) {
      batches.push(batch);
    }
    assert.deepEqual(batches, [[1, 2], [3]]);
  });
});

describe('writes are batched', () => {
  it('opens more than one transaction for a pass larger than a batch', async () => {
    // The negative form of "no whole-pass transaction": if a pass were wrapped in one
    // transaction this would be 1 however small the batch.
    const db = freshDb();
    const { adapter, stats } = observe(db);

    await ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize: 2 });

    assert.ok(
      stats.transactions > 1,
      `expected several transactions, got ${String(stats.transactions)}`,
    );
  });

  it('bounds a transaction by record count, independently of the size of the pass', async () => {
    /**
     * The acceptance criterion that matters most, because it is the one a whole-pass
     * transaction would quietly violate. The wide range covers 33 ledgers and 16
     * payment operations against the narrow range's 13 and 8 — two and a half times the
     * work — and the ceiling on a single transaction must not move.
     *
     * Five rows is the most one payment record can write: three `accounts` (source,
     * from, to, deduplicated), one `operations`, one `payments`. So a batch of N
     * records writes at most 5N statements, whatever N happens to be a batch *of*.
     */
    const MAX_ROWS_PER_PAYMENT_RECORD = 5;
    const batchSize = 3;

    async function statsFor(server: FixtureServer, range: LedgerRange): Promise<AdapterStats> {
      const db = freshDb();
      const { adapter, stats } = observe(db);
      await ingestPayments(adapter, clientFor(server), range, { batchSize });
      return stats;
    }

    const narrow = await statsFor(narrowServer, NARROW);
    const wide = await statsFor(wideServer, WIDE);
    const ceiling = batchSize * MAX_ROWS_PER_PAYMENT_RECORD;

    for (const [name, stats] of [
      ['narrow', narrow],
      ['wide', wide],
    ] as const) {
      const worst = Math.max(...stats.runsPerTransaction);
      assert.ok(
        worst <= ceiling,
        `${name}: a transaction ran ${String(worst)} statements, above the ${String(ceiling)} the batch size allows`,
      );
    }

    // And the larger pass really was larger — otherwise the bound above would hold
    // trivially because both passes did the same amount of work.
    assert.ok(
      wide.transactions > narrow.transactions,
      'the wider range should take more batches, not bigger ones',
    );
  });

  it('commits the ledger parents before any child batch opens', async () => {
    // `operations` and `trades` reference `ledgers(sequence)`, and the two passes are
    // separate loops. This pins the ordering the foreign keys depend on: every ledger
    // statement precedes every operation statement, so no committed child can point at
    // a ledger still inside an uncommitted batch.
    const db = freshDb();
    const { adapter, stats } = observe(db);

    await ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize: 2 });

    const lastLedger = stats.sqls.findLastIndex((sql) => sql.includes('INTO ledgers'));
    const firstOperation = stats.sqls.findIndex((sql) => sql.includes('INTO operations'));

    assert.ok(lastLedger >= 0 && firstOperation >= 0, 'both passes should have written');
    assert.ok(lastLedger < firstOperation, 'a ledger parent was written after an operation child');
  });
});

describe('batch size does not change the outcome', () => {
  /**
   * The regression bar restated as a property. The existing suites run at the default
   * batch size only; this pins that the granularity of the commits is all that the
   * `batchSize` knob controls.
   */
  const SIZES = [1, 3, 7, DEFAULT_BATCH_RECORDS] as const;

  it('produces identical rows for every batch size', async () => {
    let reference: string | undefined;

    for (const batchSize of SIZES) {
      const db = freshDb();
      const adapter = sqliteAdapter(db);

      await ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize });
      await ingestTrustlines(adapter, clientFor(trustlinesServer), TRUSTLINES, { batchSize });
      await ingestTrades(adapter, clientFor(tradesServer), TRADES, { batchSize });

      assert.deepEqual(
        db.pragma('foreign_key_check'),
        [],
        `broken FK at batchSize ${String(batchSize)}`,
      );

      const state = snapshot(db);
      reference ??= state;
      assert.equal(
        state,
        reference,
        `batchSize ${String(batchSize)} diverged from ${String(SIZES[0])}`,
      );
    }
  });

  it('reports identical counters for every batch size', async () => {
    let reference: string | undefined;

    for (const batchSize of SIZES) {
      const db = freshDb();
      const adapter = sqliteAdapter(db);

      const results = {
        payments: await ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize }),
        trustlines: await ingestTrustlines(adapter, clientFor(trustlinesServer), TRUSTLINES, {
          batchSize,
        }),
        trades: await ingestTrades(adapter, clientFor(tradesServer), TRADES, { batchSize }),
      };

      const serialised = JSON.stringify(results);
      reference ??= serialised;
      assert.equal(serialised, reference, `counters differ at batchSize ${String(batchSize)}`);
    }
  });
});

describe('a failed batch rolls back whole', () => {
  /**
   * Find the 1-based `run` index of the nth statement matching `fragment`.
   *
   * Derived from a clean run rather than hard coded, so a re-capture of the fixture
   * cannot silently move the injection point to a statement that proves something else.
   */
  async function runIndexOf(fragment: string, occurrence: number): Promise<number> {
    const db = freshDb();
    const { adapter, stats } = observe(db);
    await ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize: 1 });

    const matches = stats.sqls
      .map((sql, index) => ({ sql, index }))
      .filter(({ sql }) => sql.includes(fragment));
    const hit = matches[occurrence - 1];
    assert.ok(hit, `expected at least ${String(occurrence)} × "${fragment}" in a clean run`);
    return hit.index + 1;
  }

  it('discards the account and operation rows of the record whose payment insert failed', async () => {
    /**
     * With one record per batch, a record's three writes — accounts, operation,
     * payment — are the whole transaction. Failing the last of them is therefore the
     * sharpest available statement of the property: before #68 the accounts and the
     * operation would already have been committed, and the database would hold an
     * operation with no payment. Now they go together or not at all.
     */
    const failOnRun = await runIndexOf('INTO payments', 3);

    const db = freshDb();
    const { adapter } = observe(db, failOnRun);

    await assert.rejects(
      ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize: 1 }),
      /injected failure/,
    );

    assert.equal(countOf(db, 'payments'), 2, 'the two batches before the failure must survive');
    assert.equal(
      countOf(db, 'operations'),
      2,
      'the failed record must not leave its operation row behind',
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });

  it('keeps the ledger pass, which committed before the failure', async () => {
    const failOnRun = await runIndexOf('INTO payments', 3);

    const db = freshDb();
    const { adapter } = observe(db, failOnRun);
    await assert.rejects(
      ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize: 1 }),
    );

    // 13 ledgers in the recorded range, all of them written by the earlier pass. The
    // failure is in the operations pass and must not reach back into it.
    assert.equal(countOf(db, 'ledgers'), 13);
  });

  it('leaves a partial pass — neither everything nor nothing', async () => {
    // The distinguishing evidence against a whole-pass transaction. If the pass were
    // one transaction this would be 0; if nothing were batched at all it would be the
    // full 8.
    const failOnRun = await runIndexOf('INTO payments', 3);

    const db = freshDb();
    const { adapter } = observe(db, failOnRun);
    await assert.rejects(
      ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize: 1 }),
    );

    const written = countOf(db, 'payments');
    assert.ok(written > 0 && written < 8, `expected a partial pass, got ${String(written)} of 8`);
  });
});

describe('idempotency survives a mid-pass failure', () => {
  /**
   * Issue #6's guarantee is what makes batching safe to adopt: the watermark is never
   * advanced by a failed pass (see ingestIncrementalPass), so the range is re-read in
   * full, and every insert is ON CONFLICT DO NOTHING. What the committed batches wrote
   * is absorbed; what the rolled-back batch lost is rewritten.
   *
   * Asserted against a clean run rather than against fixed counts, so the claim is the
   * strong one — the recovered database is indistinguishable from one that never
   * failed.
   */
  async function cleanSnapshot(batchSize: number): Promise<string> {
    const db = freshDb();
    const adapter = sqliteAdapter(db);
    await ingestPayments(adapter, clientFor(narrowServer), NARROW, { batchSize });
    return snapshot(db);
  }

  it('converges on the clean state when the range is re-ingested', async () => {
    const expected = await cleanSnapshot(1);

    // A clean run's statement trace, used only to pick a failure point inside the
    // operations pass.
    const probe = freshDb();
    const { adapter: probeAdapter, stats } = observe(probe);
    await ingestPayments(probeAdapter, clientFor(narrowServer), NARROW, { batchSize: 1 });
    const failOnRun = stats.sqls.findIndex((sql) => sql.includes('INTO payments')) + 3;

    const db = freshDb();
    const { adapter: failing } = observe(db, failOnRun);
    await assert.rejects(
      ingestPayments(failing, clientFor(narrowServer), NARROW, { batchSize: 1 }),
    );
    assert.notEqual(snapshot(db), expected, 'the failed pass should be incomplete');

    // The recovery: the same range, the same job, a working adapter.
    const recovered = await ingestPayments(sqliteAdapter(db), clientFor(narrowServer), NARROW, {
      batchSize: 1,
    });

    assert.equal(snapshot(db), expected, 'a re-run must repair the pass that failed');
    assert.equal(recovered.paymentsSeen, 8, 'the re-run reads the whole range again');
    assert.ok(
      recovered.paymentsWritten > 0,
      'the rolled-back batch should be genuinely rewritten, not absorbed',
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });

  it('is a no-op on a further pass once repaired', async () => {
    const expected = await cleanSnapshot(2);

    const probe = freshDb();
    const { adapter: probeAdapter, stats } = observe(probe);
    await ingestPayments(probeAdapter, clientFor(narrowServer), NARROW, { batchSize: 2 });
    const failOnRun = stats.sqls.findIndex((sql) => sql.includes('INTO payments')) + 2;

    const db = freshDb();
    const { adapter: failing } = observe(db, failOnRun);
    await assert.rejects(
      ingestPayments(failing, clientFor(narrowServer), NARROW, { batchSize: 2 }),
    );

    await ingestPayments(sqliteAdapter(db), clientFor(narrowServer), NARROW, { batchSize: 2 });
    assert.equal(snapshot(db), expected);

    // The third pass is the one that would expose a repair that only looked complete.
    const third = await ingestPayments(sqliteAdapter(db), clientFor(narrowServer), NARROW, {
      batchSize: 2,
    });
    assert.equal(third.paymentsWritten, 0);
    assert.equal(third.operationsWritten, 0);
    assert.equal(third.accountsWritten, 0);
    assert.equal(third.ledgersWritten, 0);
    assert.equal(snapshot(db), expected);
  });

  it('holds for the trustlines job too, where the account parent shares the batch', async () => {
    // The trustlines job writes a parent and a child per record with no separate parent
    // pass, so a failure between them is the case most likely to orphan a row.
    const clean = freshDb();
    await ingestTrustlines(sqliteAdapter(clean), clientFor(trustlinesServer), TRUSTLINES, {
      batchSize: 1,
    });
    const expected = snapshot(clean);

    const probe = freshDb();
    const { adapter: probeAdapter, stats } = observe(probe);
    await ingestTrustlines(probeAdapter, clientFor(trustlinesServer), TRUSTLINES, { batchSize: 1 });
    const failOnRun = stats.sqls.findIndex((sql) => sql.includes('INTO trustlines')) + 3;

    const db = freshDb();
    const { adapter: failing } = observe(db, failOnRun);
    await assert.rejects(
      ingestTrustlines(failing, clientFor(trustlinesServer), TRUSTLINES, { batchSize: 1 }),
    );

    // The failing record's `accounts` parent must have gone with it.
    assert.equal(countOf(db, 'accounts'), countOf(db, 'trustlines'));
    assert.deepEqual(db.pragma('foreign_key_check'), []);

    await ingestTrustlines(sqliteAdapter(db), clientFor(trustlinesServer), TRUSTLINES, {
      batchSize: 1,
    });
    assert.equal(snapshot(db), expected);
  });
});
