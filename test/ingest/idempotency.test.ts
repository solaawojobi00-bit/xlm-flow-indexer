import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import type { LedgerRange } from '../../src/ingest/payments.ts';
import { ingestPayments } from '../../src/ingest/payments.ts';
import { ingestTrades } from '../../src/ingest/trades.ts';
import type { TrustlineIngestResult } from '../../src/ingest/trustlines.ts';
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

/**
 * An account the payments capture writes, and the recorded owner of one trustline.
 *
 * Both are real ids from the captures. `SHARED_ACCOUNT` is party to a payment in
 * [4539850, 4539862]; `RECORDED_TRUSTLINE_OWNER` establishes the COLIBRI trustline in
 * [4540630, 4540680]. Substituting the former for the latter is what creates the
 * cross-job contention — see `trustlinesSharingPaymentsAccount` below.
 */
const SHARED_ACCOUNT = 'GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV';
const RECORDED_TRUSTLINE_OWNER = 'GCJOXMQB3D5HT3VTIWLV3OOQ6A6CBVWGLRBVQKUQEDPNMJMHV3ZSBBFZ';

/** The subset of an effects page this file needs to walk in order to rewrite it. */
interface EffectsPage {
  readonly _embedded: { readonly records: { account: string; readonly type: string }[] };
}

/**
 * The trustlines capture with one `trustline_created` effect reassigned to an account
 * the payments capture also writes.
 *
 * The recorded ranges share no account at all — the payments job writes only accounts
 * party to a payment-type operation, and none of those appear in the trustlines range.
 * So the shared-`accounts` contention between two *jobs* cannot be reached by replaying
 * the captures as recorded, which is exactly why it went uncovered until a live run hit
 * it (issue #55).
 *
 * Rather than hand-author a Horizon response, this derives from the real capture and
 * changes exactly one field: the `account` on the single COLIBRI `trustline_created`
 * effect. Asset, issuer, timestamps, paging tokens and the other four effects remain
 * Horizon's own recorded data, so the ingestion path under test is unchanged.
 */
function trustlinesSharingPaymentsAccount(): Fixture {
  const derived = structuredClone(trustlinesFixture);
  let rewritten = 0;

  for (const page of Object.values(derived.responses) as EffectsPage[]) {
    for (const record of page._embedded.records) {
      if (record.type === 'trustline_created' && record.account === RECORDED_TRUSTLINE_OWNER) {
        record.account = SHARED_ACCOUNT;
        rewritten += 1;
      }
    }
  }

  // Guards the derivation itself. If a re-capture ever drops or renames that effect the
  // substitution would silently no-op, and every assertion below would still pass while
  // testing the disjoint case again.
  //
  // Deliberately raised here at module scope rather than inside `before`. A throw from
  // inside the hook leaves the fixture servers that did start unclosed, and the runner
  // then hangs on the open handles instead of reporting the failure.
  assert.equal(rewritten, 1, 'expected exactly one trustline_created effect to reassign');

  return derived;
}

const trustlinesOverlap = trustlinesSharingPaymentsAccount();

let narrowServer: FixtureServer;
let wideServer: FixtureServer;
let trustlinesServer: FixtureServer;
let tradesServer: FixtureServer;
/** Serves the derived capture above, so the trustlines job meets a payments account. */
let overlapServer: FixtureServer;

before(async () => {
  [narrowServer, wideServer, trustlinesServer, tradesServer, overlapServer] = await Promise.all([
    startFixtureServer(paymentsNarrow),
    startFixtureServer(paymentsWide),
    startFixtureServer(trustlinesFixture),
    startFixtureServer(tradesFixture),
    startFixtureServer(trustlinesOverlap),
  ]);
});

after(async () => {
  await Promise.all([
    narrowServer.close(),
    wideServer.close(),
    trustlinesServer.close(),
    tradesServer.close(),
    overlapServer.close(),
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

/**
 * How many `accounts` rows carry the id two jobs contend over.
 *
 * Asserted alongside the total account count because the two catch different faults: a
 * duplicated shared row inflates the total, whereas a parent insert wrongly skipped
 * leaves the total correct and this at zero.
 */
function sharedAccountRows(db: Db): number {
  return (
    db.prepare('SELECT COUNT(*) v FROM accounts WHERE account_id = ?').get(SHARED_ACCOUNT) as {
      v: number;
    }
  ).v;
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

describe('cross-job shared parent contention', () => {
  /**
   * Two *jobs* writing the same `accounts` row on the same database (issue #55).
   *
   * The `shared parent rows` suite above sets its contention up with a direct INSERT,
   * which proves the conflict clause fires but says nothing about how the jobs behave
   * against each other. A live-testnet run surfaced the real case: the payments job had
   * already written an account the trustlines job then also touched, producing
   * "[trustlines] 1/1 trustlines written, 0 accounts" — correct, but reached by accident
   * rather than by any test.
   *
   * The distinguishing property is that the *totals* are order-independent while each
   * job's own `accountsWritten` is not: whichever job runs second reports one fewer
   * account, because the row was already there. A test asserting only the totals would
   * pass even if a job miscounted its own writes.
   */
  const runTrustlinesOverlapping = (db: Db): Promise<TrustlineIngestResult> =>
    ingestTrustlines(db, clientFor(overlapServer), rangeOf(trustlinesFixture));

  /**
   * One account fewer than `EXPECTED_COUNTS`, which is the whole point: the payments
   * range contributes 4 accounts and the trustlines range 5, but one is now common to
   * both, so the union is 8 rather than 9.
   */
  const OVERLAP_EXPECTED_COUNTS = {
    ledgers: 164,
    accounts: 8,
    operations: 8,
    payments: 8,
    trustlines: 5,
    trades: 12,
  } as const;

  it('attributes the shared account to payments when payments runs first', async () => {
    const db = freshDb();

    const payments = await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));
    const trustlines = await runTrustlinesOverlapping(db);

    assert.equal(payments.accountsWritten, 4, 'payments inserts all four of its accounts');
    assert.equal(
      trustlines.accountsWritten,
      4,
      'trustlines touches five accounts but one was already written by payments',
    );
    assert.equal(
      trustlines.trustlinesWritten,
      5,
      'every trustline must still be written — the shared parent must not suppress the child',
    );
    assert.equal(trustlines.trustlinesSeen, 5);

    assert.equal(counts(db).accounts, 8, 'the shared account must not be duplicated');
    assert.equal(sharedAccountRows(db), 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });

  it('attributes the shared account to trustlines when trustlines runs first', async () => {
    const db = freshDb();

    const trustlines = await runTrustlinesOverlapping(db);
    const payments = await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));

    // The mirror image of the case above: the same shared row, credited to the other
    // job. This is the assertion that would catch an upsert whose accounting depended on
    // which job happened to run first.
    assert.equal(trustlines.accountsWritten, 5, 'trustlines inserts all five of its accounts');
    assert.equal(
      payments.accountsWritten,
      3,
      'payments touches four accounts but one was already written by trustlines',
    );
    assert.equal(payments.paymentsWritten, 8, 'every payment must still be written');
    assert.equal(payments.operationsWritten, 8);

    assert.equal(counts(db).accounts, 8);
    assert.equal(sharedAccountRows(db), 1);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });

  it('converges on identical state whichever job wrote the shared account first', async () => {
    const paymentsFirst = freshDb();
    await ingestPayments(paymentsFirst, clientFor(narrowServer), rangeOf(paymentsNarrow));
    await runTrustlinesOverlapping(paymentsFirst);

    const trustlinesFirst = freshDb();
    await runTrustlinesOverlapping(trustlinesFirst);
    await ingestPayments(trustlinesFirst, clientFor(narrowServer), rangeOf(paymentsNarrow));

    // Write counts differ between these two runs, as asserted above. The resulting rows
    // must not.
    assert.equal(snapshot(paymentsFirst), snapshot(trustlinesFirst));
  });

  it('is a no-op when the contending jobs are re-run', async () => {
    // The shared row is the one most likely to be rewritten on a second pass, since two
    // separate writers both claim it.
    const db = freshDb();
    await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));
    await runTrustlinesOverlapping(db);
    const baseline = snapshot(db);

    const payments = await ingestPayments(db, clientFor(narrowServer), rangeOf(paymentsNarrow));
    const trustlines = await runTrustlinesOverlapping(db);

    assert.equal(payments.accountsWritten, 0);
    assert.equal(trustlines.accountsWritten, 0);
    assert.equal(trustlines.trustlinesWritten, 0);
    assert.equal(snapshot(db), baseline);
    assert.equal(sharedAccountRows(db), 1);
  });

  it('converges for every execution order with the shared account present', async () => {
    /**
     * The same permutation set as `job order independence`, but with the contention in
     * play. That suite runs against captures whose accounts are disjoint, so no ordering
     * it tries ever makes one job meet another's `accounts` row.
     *
     * The trades job is included even though it writes no accounts, because it does write
     * `ledgers` alongside the payments job — so these orderings exercise both shared
     * parent tables at once.
     */
    const PERMUTATIONS: readonly (readonly JobName[])[] = [
      ['payments', 'trustlines', 'trades'],
      ['payments', 'trades', 'trustlines'],
      ['trustlines', 'payments', 'trades'],
      ['trustlines', 'trades', 'payments'],
      ['trades', 'payments', 'trustlines'],
      ['trades', 'trustlines', 'payments'],
    ];

    const OVERLAPPING_JOBS: Record<JobName, (db: Db) => Promise<unknown>> = {
      payments: runPayments,
      trustlines: runTrustlinesOverlapping,
      trades: runTrades,
    };

    let reference: string | undefined;
    let referenceOrder = '';

    for (const order of PERMUTATIONS) {
      const db = freshDb();
      for (const name of order) {
        await OVERLAPPING_JOBS[name](db);
      }

      assert.deepEqual(
        counts(db),
        OVERLAP_EXPECTED_COUNTS,
        `counts differ for order ${order.join(' → ')}`,
      );
      assert.equal(sharedAccountRows(db), 1, `shared account duplicated for ${order.join(' → ')}`);
      assert.deepEqual(db.pragma('foreign_key_check'), [], `broken FK for ${order.join(' → ')}`);

      const state = snapshot(db);
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
