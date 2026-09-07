import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import type { LedgerRange } from '../../src/ingest/payments.ts';
import { ingestPayments } from '../../src/ingest/payments.ts';
import { ingestTrades } from '../../src/ingest/trades.ts';
import { ingestTrustlines } from '../../src/ingest/trustlines.ts';
import {
  loadFixture,
  startFixtureServer,
  type Fixture,
  type FixtureServer,
} from '../helpers/fixture-server.ts';

/**
 * Cross-job idempotency suite (issue #6).
 *
 * The per-job suites in #3–#5 each prove idempotency for one table in isolation. The
 * failure mode this file exists to catch is the one none of them can see: two jobs
 * writing the same *parent* row — `ledgers` or `accounts` — where one uses
 * `ON CONFLICT DO NOTHING` and the other does not. That is invisible to any
 * single-job test, and it is what ARCHITECTURE.md's guarantee ("re-running a poll over
 * an already-ingested range is a no-op, not a duplicate-row bug") actually rests on.
 *
 * Every job is driven against its own recorded range, because testnet activity is
 * uneven enough that no single range carries payments, trustline effects and trades
 * together. See test/fixtures/README.md.
 */

const paymentsNarrow = loadFixture('testnet-payments-4539850-4539862');
/**
 * The same payments window widened by 10 ledgers on each side.
 *
 * Needed because the fixture server keys responses on the exact request path, and the
 * cursor for a range starting at 4539840 differs from the one for 4539850 — so an
 * overlapping-range test cannot be assembled from the narrow capture alone.
 */
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

function rangeOf(fixture: Fixture): LedgerRange {
  return { fromLedger: fixture.fromLedger, toLedger: fixture.toLedger };
}

const TABLES = ['ledgers', 'accounts', 'operations', 'payments', 'trustlines', 'trades'] as const;

/**
 * A deterministic ordering for every table, used when comparing whole-database state.
 *
 * `SELECT *` with no ORDER BY returns rows in rowid — that is, insertion — order, and
 * insertion order into the shared `accounts` table genuinely does depend on which job
 * ran first. Comparing raw selects would therefore report a difference for every
 * permutation in the order-independence test below, when the *contents* are identical.
 * The property under test is the state the database holds, not the order SQLite happens
 * to have stored it in, so the comparison sorts by primary key.
 */
const ORDER_BY: Record<(typeof TABLES)[number], string> = {
  ledgers: 'sequence',
  accounts: 'account_id',
  operations: 'id',
  payments: 'operation_id',
  trustlines: 'account_id, asset_code, asset_issuer',
  trades: 'id',
};

function counts(db: Db): Record<string, number> {
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    result[table] = (db.prepare(`SELECT COUNT(*) v FROM ${table}`).get() as { v: number }).v;
  }
  return result;
}

/** Full contents of every table, primary-key ordered — the canonical database state. */
function snapshot(db: Db): string {
  const state: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    state[table] = db.prepare(`SELECT * FROM ${table} ORDER BY ${ORDER_BY[table]}`).all();
  }
  return JSON.stringify(state);
}

const runPayments = (db: Db): Promise<unknown> =>
  ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));
const runTrustlines = (db: Db): Promise<unknown> =>
  ingestTrustlines(db, clientFor(trustlinesServer), rangeOf(trustlinesFixture));
const runTrades = (db: Db): Promise<unknown> =>
  ingestTrades(db, clientFor(tradesServer), rangeOf(tradesFixture));

const JOBS = {
  payments: runPayments,
  trustlines: runTrustlines,
  trades: runTrades,
} as const;
type JobName = keyof typeof JOBS;

async function ingestAll(db: Db, order: readonly JobName[]): Promise<void> {
  for (const name of order) {
    await JOBS[name](db);
  }
}

/**
 * Row counts after one full pass of all three jobs over their pinned ranges.
 *
 * Hard coded against the recorded data rather than derived from the fixtures: deriving
 * them would make the assertions tautological. `ledgers` is much larger than the other
 * tables because both the payments and trades jobs write every ledger in their range,
 * not only the ones carrying a record of interest — 13 from the payments range and 151
 * from the trades range.
 */
const EXPECTED_COUNTS = {
  ledgers: 164,
  accounts: 9,
  operations: 8,
  payments: 8,
  trustlines: 5,
  trades: 12,
} as const;

describe('full re-ingest is a no-op', () => {
  it('writes nothing on a second pass over the same ranges', async () => {
    const db = freshDb();

    await ingestAll(db, ['payments', 'trustlines', 'trades']);
    assert.deepEqual(counts(db), EXPECTED_COUNTS, 'first pass should populate every table');
    const afterFirstPass = snapshot(db);

    // Every job reports what it actually wrote, so the guarantee can be asserted on the
    // jobs' own accounting as well as on the resulting rows.
    const payments = await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));
    const trustlines = await ingestTrustlines(
      db,
      clientFor(trustlinesServer),
      rangeOf(trustlinesFixture),
    );
    const trades = await ingestTrades(db, clientFor(tradesServer), rangeOf(tradesFixture));

    assert.equal(payments.ledgersWritten, 0);
    assert.equal(payments.accountsWritten, 0);
    assert.equal(payments.operationsWritten, 0);
    assert.equal(payments.paymentsWritten, 0);
    assert.equal(trustlines.accountsWritten, 0);
    assert.equal(trustlines.trustlinesWritten, 0);
    assert.equal(trades.ledgersWritten, 0);
    assert.equal(trades.tradesWritten, 0);

    // The jobs still see the same records — nothing was skipped on the read side, the
    // writes were simply absorbed by the conflict clauses.
    assert.equal(payments.paymentsSeen, 8);
    assert.equal(trustlines.trustlinesSeen, 5);
    assert.equal(trades.tradesSeen, 12);

    assert.equal(snapshot(db), afterFirstPass, 'second pass must not change any row');
  });

  it('is still a no-op on a third pass', async () => {
    // Two passes could pass by accident if a job were somehow self-correcting. A third
    // pins the property as stable rather than alternating.
    const db = freshDb();
    await ingestAll(db, ['payments', 'trustlines', 'trades']);
    const baseline = snapshot(db);

    await ingestAll(db, ['payments', 'trustlines', 'trades']);
    await ingestAll(db, ['payments', 'trustlines', 'trades']);

    assert.equal(snapshot(db), baseline);
    assert.deepEqual(counts(db), EXPECTED_COUNTS);
  });
});

describe('overlapping ranges', () => {
  /**
   * Ingest [4539850, 4539862], then the wider [4539840, 4539872] that contains it.
   *
   * The widened range covers 33 ledgers and 16 payment operations against the narrow
   * range's 13 and 8, so exactly 20 ledgers and 8 payments are genuinely new. Anything
   * more means the overlap was re-inserted; anything less means real data was dropped.
   */
  it('adds only the genuinely new ledgers', async () => {
    const db = freshDb();

    const narrow = await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));
    assert.equal(narrow.ledgersWritten, 13);
    assert.equal(narrow.paymentsWritten, 8);
    assert.deepEqual(counts(db), {
      ledgers: 13,
      accounts: 4,
      operations: 8,
      payments: 8,
      trustlines: 0,
      trades: 0,
    });

    const wide = await ingestPayments(db, clientFor(wideServer), rangeOf(paymentsWide));

    assert.equal(wide.ledgersWritten, 20, '33 ledgers in range, 13 already present');
    assert.equal(wide.operationsWritten, 8, '16 payment operations in range, 8 already present');
    assert.equal(wide.paymentsWritten, 8);
    // The four accounts in the narrow range are the only ones the wider range touches,
    // so the widened pass writes no new account at all — direct evidence that the
    // parent insert is absorbed rather than duplicated.
    assert.equal(wide.accountsWritten, 0);

    assert.deepEqual(counts(db), {
      ledgers: 33,
      accounts: 4,
      operations: 16,
      payments: 16,
      trustlines: 0,
      trades: 0,
    });
  });

  it('leaves the rows in the overlap byte-for-byte unchanged', async () => {
    const db = freshDb();
    await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));

    const overlapBefore = db
      .prepare(`SELECT * FROM ledgers WHERE sequence BETWEEN 4539850 AND 4539862 ORDER BY sequence`)
      .all();
    const paymentsBefore = db.prepare('SELECT * FROM payments ORDER BY operation_id').all();

    await ingestPayments(db, clientFor(wideServer), rangeOf(paymentsWide));

    const overlapAfter = db
      .prepare(`SELECT * FROM ledgers WHERE sequence BETWEEN 4539850 AND 4539862 ORDER BY sequence`)
      .all();

    assert.equal(overlapBefore.length, 13);
    assert.deepEqual(overlapAfter, overlapBefore, 'overlapped ledger rows must not be rewritten');

    // Every payment from the narrow pass must still be present and identical. A row
    // rewritten with a re-fetched value would compare equal on counts but not here.
    assert.equal(paymentsBefore.length, 8);
    for (const row of paymentsBefore as { operation_id: string }[]) {
      const current = db
        .prepare('SELECT * FROM payments WHERE operation_id = ?')
        .get(row.operation_id);
      assert.deepEqual(current, row);
    }
  });
});

describe('job order independence', () => {
  /**
   * All six orderings of the three jobs must converge on the same database.
   *
   * This is the permutation set that would expose a parent-row write without a conflict
   * clause: whichever job runs second or third meets rows the first already inserted.
   */
  const PERMUTATIONS: readonly (readonly JobName[])[] = [
    ['payments', 'trustlines', 'trades'],
    ['payments', 'trades', 'trustlines'],
    ['trustlines', 'payments', 'trades'],
    ['trustlines', 'trades', 'payments'],
    ['trades', 'payments', 'trustlines'],
    ['trades', 'trustlines', 'payments'],
  ];

  it('converges on identical state for every execution order', async () => {
    let reference: string | undefined;
    let referenceOrder = '';

    for (const order of PERMUTATIONS) {
      const db = freshDb();
      await ingestAll(db, order);

      const state = snapshot(db);
      assert.deepEqual(counts(db), EXPECTED_COUNTS, `counts differ for order ${order.join(' → ')}`);

      if (reference === undefined) {
        reference = state;
        referenceOrder = order.join(' → ');
      } else {
        assert.equal(
          state,
          reference,
          `order ${order.join(' → ')} diverged from ${referenceOrder}`,
        );
      }
    }
  });

  it('converges even when a job is run twice mid-sequence', async () => {
    // Incremental ingestion (BACKLOG.md item 18) will not run the jobs in a tidy
    // one-pass-each order, so a repeat in the middle must be as harmless as a repeat
    // at the end.
    const db = freshDb();
    await ingestAll(db, ['payments', 'payments', 'trustlines', 'trades', 'trustlines']);

    const expected = freshDb();
    await ingestAll(expected, ['payments', 'trustlines', 'trades']);

    assert.equal(snapshot(db), snapshot(expected));
  });
});

describe('shared parent rows', () => {
  /**
   * A parent row already written by another source must not be rewritten or rejected.
   *
   * The recorded ranges happen to contain no account that two jobs both write — the
   * payments job writes only the accounts party to a payment-type operation, and none
   * of those appear in the trustlines range (see test/fixtures/README.md). So the
   * contention is set up explicitly, with a real recorded account id, rather than
   * relying on an accident of the capture that a re-capture could remove.
   */
  const TRUSTLINE_ACCOUNT = 'GCJOXMQB3D5HT3VTIWLV3OOQ6A6CBVWGLRBVQKUQEDPNMJMHV3ZSBBFZ';

  it('absorbs an account another writer already inserted', async () => {
    const db = freshDb();
    db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run(TRUSTLINE_ACCOUNT);

    const result = await ingestTrustlines(
      db,
      clientFor(trustlinesServer),
      rangeOf(trustlinesFixture),
    );

    assert.equal(result.accountsWritten, 4, 'one of the five accounts was already present');
    assert.equal(result.trustlinesWritten, 5, 'all five trustlines must still be written');
    assert.equal(counts(db).accounts, 5, 'the pre-existing account must not be duplicated');
  });

  it('writes each ledger once even though two jobs write ledgers', async () => {
    // The payments and trades jobs both write into `ledgers`. Their recorded ranges are
    // disjoint, so this asserts the additive case; the overlapping case is covered by
    // the widened payments range above.
    const db = freshDb();
    const payments = await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));
    const trades = await ingestTrades(db, clientFor(tradesServer), rangeOf(tradesFixture));

    assert.equal(payments.ledgersWritten, 13);
    assert.equal(trades.ledgersWritten, 151);
    assert.equal(counts(db).ledgers, 164);

    const duplicates = db
      .prepare('SELECT sequence, COUNT(*) v FROM ledgers GROUP BY sequence HAVING v > 1')
      .all();
    assert.deepEqual(duplicates, []);
  });

  it('keeps every foreign key satisfied', async () => {
    // Idempotency is only worth having if the deduplicated rows still hang together.
    // A parent insert wrongly skipped would show up here rather than as a row count.
    const db = freshDb();
    await ingestAll(db, ['trades', 'trustlines', 'payments']);

    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
});

describe('native asset encoding', () => {
  /**
   * The NULL-issuer primary key quirk corrected in issue #1 is the reason this suite
   * exists at all, so native rows get their own coverage.
   *
   * One acceptance criterion on issue #6 asks for a native *trustline* in the fixture
   * data. There is no such thing to record: every Stellar account holds XLM without a
   * trustline, and `ingestTrustlines` deliberately drops any effect claiming otherwise.
   * The quirk is therefore pinned two ways instead — against real native payment and
   * trade rows, and against a direct insert that reproduces exactly the collision the
   * `NOT NULL DEFAULT ''` encoding exists to make impossible.
   */
  it('stores native payments with an empty-string issuer', async () => {
    const db = freshDb();
    await runPayments(db);

    const native = db
      .prepare(`SELECT COUNT(*) v FROM payments WHERE asset_code = 'native' AND asset_issuer = ''`)
      .get() as { v: number };
    const issued = db.prepare(`SELECT COUNT(*) v FROM payments WHERE asset_issuer <> ''`).get() as {
      v: number;
    };
    const nulls = db
      .prepare('SELECT COUNT(*) v FROM payments WHERE asset_issuer IS NULL')
      .get() as { v: number };

    assert.equal(native.v, 7);
    assert.equal(issued.v, 1);
    assert.equal(nulls.v, 0, 'a NULL issuer would defeat idempotency in SQLite');
  });

  it('stores native trade legs with an empty-string issuer', async () => {
    const db = freshDb();
    await runTrades(db);

    const nativeBase = db
      .prepare(
        `SELECT COUNT(*) v FROM trades WHERE base_asset_code = 'native' AND base_asset_issuer = ''`,
      )
      .get() as { v: number };
    assert.equal(nativeBase.v, 8);

    const nulls = db
      .prepare(
        'SELECT COUNT(*) v FROM trades WHERE base_asset_issuer IS NULL OR counter_asset_issuer IS NULL',
      )
      .get() as { v: number };
    assert.equal(nulls.v, 0);

    // Both mechanisms are present, so re-ingest is proven idempotent for pool trades
    // and order-book trades alike rather than only for whichever is more common.
    assert.deepEqual(
      db.prepare('SELECT trade_type, COUNT(*) v FROM trades GROUP BY trade_type ORDER BY 1').all(),
      [
        { trade_type: 'liquidity_pool', v: 3 },
        { trade_type: 'orderbook', v: 9 },
      ],
    );
  });

  it('re-ingests native rows without duplicating them', async () => {
    const db = freshDb();
    await runPayments(db);
    await runTrades(db);
    const baseline = snapshot(db);

    await runPayments(db);
    await runTrades(db);

    assert.equal(snapshot(db), baseline);
  });

  it('holds the trustlines primary key for an empty-string issuer', () => {
    // The regression guard for issue #1. With `asset_issuer` nullable and NULL used for
    // native, SQLite would admit this row twice — a non-INTEGER primary key does not
    // enforce uniqueness across NULL columns — and every trustline idempotency
    // assertion elsewhere would silently stop meaning anything.
    const db = freshDb();
    db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run('GTEST');

    const insert = db.prepare(
      `INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );

    assert.equal(insert.run('GTEST', 'native', '', '2026-01-01T00:00:00Z').changes, 1);
    assert.equal(
      insert.run('GTEST', 'native', '', '2026-06-01T00:00:00Z').changes,
      0,
      'the empty-string issuer must collide on the primary key',
    );
    assert.equal(counts(db).trustlines, 1);

    // Earliest establishment wins, per the policy documented on ingestTrustlines.
    const row = db.prepare('SELECT established_at FROM trustlines').get() as {
      established_at: string;
    };
    assert.equal(row.established_at, '2026-01-01T00:00:00Z');
  });

  it('rejects a NULL issuer outright', () => {
    // The column is NOT NULL precisely so the nullable form cannot come back by
    // accident. If this ever stops throwing, the schema has regressed.
    const db = freshDb();
    db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run('GTEST');

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run('GTEST', 'native', null, '2026-01-01T00:00:00Z'),
      /NOT NULL/,
    );
  });
});
