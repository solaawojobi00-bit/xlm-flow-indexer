import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { SqlAdapter } from '../../src/db/adapter.ts';
import { pgAdapter, toPositionalPlaceholders, type PgConnection } from '../../src/db/pg-adapter.ts';
import { migratePostgres } from '../../src/db/postgres.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { ingestPayments } from '../../src/ingest/payments.ts';
import { lastIngestedLedger, recordIngestedLedger } from '../../src/ingest/state.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

/**
 * The Postgres half of the adapter contract (issue #72).
 *
 * Split in two on purpose. The placeholder scanner is pure and its suite runs
 * everywhere, because it is where the interesting failure modes live and none of
 * them need a server. The adapter's behaviour needs the real engine — the whole
 * question is what Postgres does with a second BEGIN or a rolled-back
 * connection — so those suites skip when DATABASE_URL is unset, exactly as
 * test/postgres.test.ts does.
 */

describe('toPositionalPlaceholders', () => {
  it('numbers placeholders from one, in order', () => {
    assert.equal(
      toPositionalPlaceholders('INSERT INTO accounts (a, b, c) VALUES (?, ?, ?)'),
      'INSERT INTO accounts (a, b, c) VALUES ($1, $2, $3)',
    );
  });

  it('leaves SQL without placeholders alone', () => {
    assert.equal(toPositionalPlaceholders('SELECT 1'), 'SELECT 1');
  });

  it('ignores a question mark inside a string literal', () => {
    assert.equal(
      toPositionalPlaceholders(`SELECT ? WHERE note = 'what?'`),
      `SELECT $1 WHERE note = 'what?'`,
    );
  });

  it('treats a doubled quote as an escape rather than the end of the literal', () => {
    // If '' were read as close-then-open, everything after it would be scanned
    // as ordinary SQL and the ? inside the literal would be rewritten.
    assert.equal(
      toPositionalPlaceholders(`SELECT ? WHERE note = 'it''s a ? here'`),
      `SELECT $1 WHERE note = 'it''s a ? here'`,
    );
  });

  it('honours backslash escapes only inside an E-string', () => {
    // E'...' is the one literal form where a backslash escapes. Reading \' as an
    // escape here is what keeps the literal from appearing to end early.
    assert.equal(
      toPositionalPlaceholders(`SELECT ? WHERE note = E'\\' ? still inside'`),
      `SELECT $1 WHERE note = E'\\' ? still inside'`,
    );
  });

  it('does not apply backslash escapes to an ordinary literal', () => {
    // standard_conforming_strings is on by default, so this literal ends at the
    // second quote and the ? after it really is a placeholder.
    assert.equal(
      toPositionalPlaceholders(`SELECT 'back\\' , ? FROM t`),
      `SELECT 'back\\' , $1 FROM t`,
    );
  });

  it('ignores a question mark inside a quoted identifier', () => {
    assert.equal(
      toPositionalPlaceholders(`SELECT "odd?column" FROM t WHERE a = ?`),
      `SELECT "odd?column" FROM t WHERE a = $1`,
    );
  });

  it('treats a doubled double-quote as an escape', () => {
    assert.equal(
      toPositionalPlaceholders(`SELECT "a""b?c" FROM t WHERE a = ?`),
      `SELECT "a""b?c" FROM t WHERE a = $1`,
    );
  });

  it('ignores a question mark inside a dollar-quoted string', () => {
    assert.equal(toPositionalPlaceholders('SELECT $$ what? $$, ?'), 'SELECT $$ what? $$, $1');
  });

  it('ignores a question mark inside a tagged dollar-quoted string', () => {
    assert.equal(
      toPositionalPlaceholders('SELECT $body$ a ? b $body$, ?'),
      'SELECT $body$ a ? b $body$, $1',
    );
  });

  it('rejects SQL that already carries its own positional placeholder', () => {
    // Written for pg rather than for the seam. Converting it would number a
    // fresh $1 alongside the existing one, and the driver would bind a value to
    // only one of the two -- wrong, and silent about it.
    assert.throws(
      () => toPositionalPlaceholders('SELECT $1, ?'),
      /already contains a positional placeholder \(\$1\)/,
    );
  });

  it('still treats $$ as a dollar quote rather than a placeholder', () => {
    // The digit rule that makes the case above detectable is the same one that
    // keeps a real dollar quote working: a tag is an identifier, so it cannot
    // start with a digit, and $$ has no tag at all.
    assert.equal(toPositionalPlaceholders('SELECT $$a$$, ?'), 'SELECT $$a$$, $1');
  });

  it('ignores a question mark in a line comment', () => {
    assert.equal(
      toPositionalPlaceholders('SELECT ? -- really? yes\n, ?'),
      'SELECT $1 -- really? yes\n, $2',
    );
  });

  it('ignores a question mark in a block comment', () => {
    assert.equal(toPositionalPlaceholders('SELECT /* ? */ ?'), 'SELECT /* ? */ $1');
  });

  it('handles nested block comments, which Postgres allows', () => {
    // In C this comment would end at the first */ and the trailing ? would be
    // read as a placeholder. Postgres nests, so it does not.
    assert.equal(
      toPositionalPlaceholders('SELECT /* a /* ? */ ? */ ?'),
      'SELECT /* a /* ? */ ? */ $1',
    );
  });

  it('converts the real watermark upsert', () => {
    // The statement from src/ingest/state.ts, which is the one with the most to
    // go wrong: three placeholders, an ON CONFLICT target and a WHERE predicate.
    const converted = toPositionalPlaceholders(
      `INSERT INTO ingest_state (job, last_ledger, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (job) DO UPDATE SET
         last_ledger = excluded.last_ledger,
         updated_at  = excluded.updated_at
       WHERE excluded.last_ledger > ingest_state.last_ledger`,
    );

    assert.match(converted, /VALUES \(\$1, \$2, \$3\)/);
    assert.doesNotMatch(converted, /\?/);
  });
});

describe('pgAdapter placeholder caching', () => {
  it('converts a given SQL string once and reuses the result', async () => {
    // The counterpart to the SQLite adapter's compiled-statement cache. The
    // observable part is that the connection sees identical converted SQL every
    // time, rather than a rescan drifting.
    const seen: string[] = [];
    const fake: PgConnection = {
      query: (sql: string) => {
        seen.push(sql);
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
      end: () => Promise.resolve(),
    };
    const sql = pgAdapter(fake);

    await sql.run('INSERT INTO accounts (account_id) VALUES (?)', ['GA']);
    await sql.run('INSERT INTO accounts (account_id) VALUES (?)', ['GB']);

    assert.deepEqual(seen, [
      'INSERT INTO accounts (account_id) VALUES ($1)',
      'INSERT INTO accounts (account_id) VALUES ($1)',
    ]);
  });

  it('reports itself as the postgres dialect', () => {
    const fake: PgConnection = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      end: () => Promise.resolve(),
    };
    assert.equal(pgAdapter(fake).dialect, 'postgres');
  });

  it('normalises a null rowCount to zero', async () => {
    // pg reports null for statements that carry no count. Left as null it would
    // reach an IngestResult counter and turn the running total into NaN.
    const fake: PgConnection = {
      query: () => Promise.resolve({ rows: [], rowCount: null }),
      end: () => Promise.resolve(),
    };
    assert.equal((await pgAdapter(fake).run('SELECT 1')).rowsAffected, 0);
  });

  it('ends the connection only when given ownership', async () => {
    let ends = 0;
    const fake: PgConnection = {
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      end: () => {
        ends += 1;
        return Promise.resolve();
      },
    };

    await pgAdapter(fake).close();
    assert.equal(ends, 0, 'a borrowed connection is left open');

    const owning = pgAdapter(fake, { closeConnection: true });
    await owning.close();
    await owning.close();
    assert.equal(ends, 1, 'close() is safe to call twice');
  });
});

/* -------------------------------------------------------------------------- */
/* Everything below needs a real server.                                       */
/* -------------------------------------------------------------------------- */

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'DATABASE_URL is not set (no Postgres available)';

/** A dedicated schema, so this suite cannot collide with test/postgres.test.ts. */
const SCHEMA = 'xlm_flow_indexer_adapter_test';

type Client = import('pg').Client;
let client: Client | undefined;

before(async () => {
  if (!DATABASE_URL) return;
  const { Client: PgClient } = await import('pg');
  client = new PgClient({ connectionString: DATABASE_URL });
  await client.connect();
});

after(async () => {
  if (client) {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  }
});

/**
 * A migrated, empty schema.
 *
 * Called from each server-gated suite's own `beforeEach` rather than from a
 * top-level one, which would also run a full migration before each of the pure
 * scanner cases above — work with no bearing on what they assert.
 */
async function resetSchema(): Promise<void> {
  if (!client) return;
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await migratePostgres(client);
}

function conn(): Client {
  if (!client) throw new Error('Postgres client not initialised');
  return client;
}

/** The adapter under test, over the suite's own connection. */
function adapter(): SqlAdapter {
  return pgAdapter(conn());
}

async function countOf(table: string): Promise<number> {
  const result = await conn().query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return (result.rows[0] as { c: number }).c;
}

const INSERT_ACCOUNT = 'INSERT INTO accounts (account_id) VALUES (?) ON CONFLICT DO NOTHING';

describe('pgAdapter against a real server', { skip }, () => {
  beforeEach(resetSchema);

  it('reports rows actually written', async () => {
    assert.equal((await adapter().run(INSERT_ACCOUNT, ['GONE'])).rowsAffected, 1);
  });

  it('reports zero when ON CONFLICT DO NOTHING suppressed the write', async () => {
    // The property every "written" counter in src/ingest/ depends on, asserted
    // here against rowCount rather than better-sqlite3's changes.
    const sql = adapter();
    await sql.run(INSERT_ACCOUNT, ['GONE']);

    assert.equal((await sql.run(INSERT_ACCOUNT, ['GONE'])).rowsAffected, 0);
  });

  it('returns undefined from get when nothing matched', async () => {
    assert.equal(
      await adapter().get('SELECT account_id FROM accounts WHERE account_id = ?', ['nope']),
      undefined,
    );
  });

  it('returns an empty array from all when nothing matched', async () => {
    assert.deepEqual(await adapter().all('SELECT account_id FROM accounts'), []);
  });

  it('binds parameters positionally', async () => {
    const sql = adapter();
    await sql.run(INSERT_ACCOUNT, ['GALICE']);
    await sql.run(INSERT_ACCOUNT, ['GBOB']);

    const row = await sql.get<{ account_id: string }>(
      'SELECT account_id FROM accounts WHERE account_id = ?',
      ['GBOB'],
    );
    assert.equal(row?.account_id, 'GBOB');
  });

  it('binds a boolean natively rather than as 1/0', async () => {
    // The SQLite adapter converts booleans because better-sqlite3 refuses them.
    // Copying that conversion here would store the string "1" against a boolean
    // column, so this pins that it does not happen.
    const row = await adapter().get<{ flag: boolean }>('SELECT ?::boolean AS flag', [true]);
    assert.equal(row?.flag, true);
  });

  it('writes an exact NUMERIC amount through the seam', async () => {
    // The precision argument from #48, now through the adapter rather than a
    // raw query: the largest Stellar amount needs all 19 significant digits.
    const sql = adapter();
    await sql.run('INSERT INTO ledgers (sequence, closed_at, operation_count) VALUES (?, ?, ?)', [
      1,
      '2026-01-01T00:00:00Z',
      1,
    ]);
    await sql.run(INSERT_ACCOUNT, ['GFROM']);
    await sql.run(INSERT_ACCOUNT, ['GTO']);
    await sql.run(
      `INSERT INTO operations (id, ledger_sequence, type, source_account, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['op1', 1, 'payment', 'GFROM', '2026-01-01T00:00:00Z'],
    );
    await sql.run(
      `INSERT INTO payments (operation_id, from_account, to_account, asset_code, asset_issuer, amount)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['op1', 'GFROM', 'GTO', 'native', '', '922337203685.4775807'],
    );

    const row = await sql.get<{ amount: string }>('SELECT amount FROM payments');
    assert.equal(row?.amount, '922337203685.4775807');
  });

  it('round-trips a watermark through the shared state module', async () => {
    // src/ingest/state.ts unmodified, driven by the Postgres adapter. The upsert
    // it runs is the statement #52 had to rewrite to stay portable.
    const sql = adapter();
    assert.equal(await lastIngestedLedger(sql, 'payments'), undefined);

    await recordIngestedLedger(sql, 'payments', 100);
    assert.equal(await lastIngestedLedger(sql, 'payments'), 100);

    await recordIngestedLedger(sql, 'payments', 50);
    assert.equal(await lastIngestedLedger(sql, 'payments'), 100, 'still monotonic');
  });
});

describe('pgAdapter transactions against a real server', { skip }, () => {
  beforeEach(resetSchema);

  it('commits the work when the callback returns', async () => {
    const returned = await adapter().transaction(async (tx) => {
      await tx.run(INSERT_ACCOUNT, ['GALICE']);
      await tx.run(INSERT_ACCOUNT, ['GBOB']);
      return 'done';
    });

    assert.equal(returned, 'done');
    assert.equal(await countOf('accounts'), 2);
  });

  it('survives a real await between statements', async () => {
    // The case that forced the manual BEGIN in #67. It cannot fail the same way
    // here -- pg has no synchronous-callback helper to misuse -- but the
    // contract is the seam's, not one adapter's, so both are held to it.
    await adapter().transaction(async (tx) => {
      await tx.run(INSERT_ACCOUNT, ['GEARLY']);
      await delay(5);
      await tx.run(INSERT_ACCOUNT, ['GLATE']);
    });

    assert.equal(await countOf('accounts'), 2, 'both sides of the await must be committed');
  });

  it('rolls back every statement when the callback throws', async () => {
    const sql = adapter();
    await sql.run(INSERT_ACCOUNT, ['GBEFORE']);

    await assert.rejects(
      () =>
        sql.transaction(async (tx) => {
          await tx.run(INSERT_ACCOUNT, ['GDOOMED']);
          throw new Error('bad entry');
        }),
      /bad entry/,
    );

    assert.equal(await countOf('accounts'), 1, 'only the pre-transaction row survives');
  });

  it('leaves the connection usable after a rollback', async () => {
    // Postgres puts a connection into "current transaction is aborted" after an
    // error and rejects everything until the transaction ends. If the adapter
    // failed to issue ROLLBACK, this next write is what would fail.
    const sql = adapter();

    await assert.rejects(
      () =>
        sql.transaction(async (tx) => {
          await tx.run(INSERT_ACCOUNT, ['GDOOMED']);
          throw new Error('bad entry');
        }),
      /bad entry/,
    );

    await sql.run(INSERT_ACCOUNT, ['GAFTER']);
    assert.equal(await countOf('accounts'), 1);
  });

  it('rolls back after an error raised by the server itself', async () => {
    // Not a thrown JavaScript error but a constraint violation, which is what
    // leaves the connection in the aborted state.
    const sql = adapter();

    await assert.rejects(() =>
      sql.transaction(async (tx) => {
        await tx.run(INSERT_ACCOUNT, ['GOK']);
        await tx.run('INSERT INTO accounts (account_id) VALUES (?)', ['GOK']);
      }),
    );

    assert.equal(await countOf('accounts'), 0);
    await sql.run(INSERT_ACCOUNT, ['GAFTER']);
    assert.equal(await countOf('accounts'), 1);
  });

  it('refuses to nest', async () => {
    // Postgres answers a second BEGIN with a warning rather than an error, so
    // without the guard the inner block would appear to work and would be
    // committing the outer one's rows.
    await assert.rejects(
      () => adapter().transaction((tx) => tx.transaction(() => Promise.resolve())),
      /Nested SqlAdapter\.transaction\(\) is not supported/,
    );
  });

  it('can open a new transaction after one failed', async () => {
    const sql = adapter();

    await assert.rejects(() => sql.transaction(() => Promise.reject(new Error('nope'))), /nope/);

    await sql.transaction(async (tx) => {
      await tx.run(INSERT_ACCOUNT, ['GNEXT']);
    });
    assert.equal(await countOf('accounts'), 1, 'the nesting guard must have been released');
  });
});

describe('an ingestion job runs against Postgres', { skip }, () => {
  /**
   * The assertion the whole seam exists for (issues #67 and #72).
   *
   * `ingestPayments` is imported unmodified and handed a Postgres adapter
   * instead of a SQLite one. Nothing in src/ingest/ knows which engine it is
   * writing to, and this is what proves it rather than asserting it.
   */
  const FIXTURE_NAME = 'testnet-payments-4539850-4539862';
  const fixture = loadFixture(FIXTURE_NAME);
  let server: FixtureServer;

  beforeEach(resetSchema);

  before(async () => {
    server = await startFixtureServer(fixture);
  });

  after(async () => {
    await server.close();
  });

  it('writes payments, operations, accounts and ledgers', async () => {
    const sql = adapter();
    const horizon = new HorizonClient({ baseUrl: server.baseUrl });

    const result = await ingestPayments(sql, horizon, {
      fromLedger: fixture.fromLedger,
      toLedger: fixture.toLedger,
    });

    assert.ok(result.paymentsWritten > 0, 'the fixture range contains payments');
    assert.equal(await countOf('payments'), result.paymentsWritten);
    assert.equal(await countOf('operations'), result.operationsWritten);
    assert.equal(await countOf('ledgers'), result.ledgersWritten);
    assert.equal(await countOf('accounts'), result.accountsWritten);
  });

  it('is idempotent on a second pass', async () => {
    // Issue #6's property, re-verified on the other engine. The counts must come
    // back zero because rowCount under ON CONFLICT DO NOTHING says written, not
    // seen -- the same thing `changes` says in SQLite.
    const sql = adapter();
    const horizon = new HorizonClient({ baseUrl: server.baseUrl });
    const range = { fromLedger: fixture.fromLedger, toLedger: fixture.toLedger };

    const first = await ingestPayments(sql, horizon, range);
    const second = await ingestPayments(sql, horizon, range);

    assert.ok(first.paymentsWritten > 0);
    assert.equal(second.paymentsWritten, 0, 'nothing new on the second pass');
    assert.equal(second.operationsWritten, 0);
    assert.equal(second.ledgersWritten, 0);
    assert.equal(second.accountsWritten, 0);
    assert.equal(
      second.paymentsSeen,
      first.paymentsSeen,
      'the same rows were seen, they were simply already present',
    );
    assert.equal(await countOf('payments'), first.paymentsWritten);
  });
});
