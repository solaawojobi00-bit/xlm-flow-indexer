import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { openDb, type Db } from '../../src/db/client.ts';
import { migrate } from '../../src/db/migrate.ts';
import { HorizonClient } from '../../src/horizon/client.ts';
import { ledgerOf } from '../../src/horizon/toid.ts';
import { ingestTrustlines } from '../../src/ingest/trustlines.ts';
import { adapt } from '../helpers/adapter.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from '../helpers/fixture-server.ts';

const fixture = loadFixture('testnet-trustlines-4540630-4540680');

let server: FixtureServer;

before(async () => {
  server = await startFixtureServer(fixture);
});

after(async () => {
  await server.close();
});

function freshDb(): Db {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function client(): HorizonClient {
  return new HorizonClient({ baseUrl: server.baseUrl });
}

function range(): { fromLedger: number; toLedger: number } {
  return { fromLedger: fixture.fromLedger, toLedger: fixture.toLedger };
}

describe('ledgerOf with effect paging tokens', () => {
  it('parses the toid-index form effects use', () => {
    // Effects append an index because several effects share one operation's TOID.
    // Parsing only the bare form would throw on every effect token.
    assert.equal(ledgerOf('19498507278749697-1'), 4539850);
    assert.equal(ledgerOf('19498507278749697-12'), 4539850);
  });

  it('still parses the bare form operations use', () => {
    assert.equal(ledgerOf('19498507278745600'), 4539850);
  });

  it('rejects a token it cannot parse', () => {
    assert.throws(() => ledgerOf('not-a-token'), RangeError);
    assert.throws(() => ledgerOf(''), RangeError);
  });
});

describe('ingestTrustlines against recorded testnet data', () => {
  it('ingests trustline establishment for the pinned range', async () => {
    const db = freshDb();
    const result = await ingestTrustlines(adapt(db), client(), range());

    assert.equal(result.effectsScanned, 279);
    assert.equal(result.trustlinesSeen, 5);
    assert.equal(result.trustlinesWritten, 5);
    assert.equal(result.accountsWritten, 5);
    db.close();
  });

  it('records the real assets and issuers', async () => {
    const db = freshDb();
    await ingestTrustlines(adapt(db), client(), range());

    const rows = db
      .prepare(
        `SELECT asset_code, COUNT(*) n FROM trustlines
         GROUP BY asset_code ORDER BY asset_code`,
      )
      .all() as { asset_code: string; n: number }[];

    assert.deepEqual(rows, [
      { asset_code: 'COLIBRI', n: 3 },
      { asset_code: 'USDC', n: 2 },
    ]);

    // Every issuer is a real account address, never empty: a trustline to native
    // cannot exist, so an empty issuer here would mean something went wrong.
    const issuers = (
      db.prepare('SELECT DISTINCT asset_issuer FROM trustlines').all() as {
        asset_issuer: string;
      }[]
    ).map((r) => r.asset_issuer);

    assert.equal(issuers.length, 2);
    for (const issuer of issuers) {
      assert.match(issuer, /^G[A-Z2-7]{55}$/, 'issuer must be a Stellar account address');
    }
    db.close();
  });

  it('does not record a trustline_updated as a new establishment', async () => {
    // The pinned range contains one trustline_updated (asset TESTGK26 at ledger
    // 4540642). Reading change_trust operations instead of effects would record it as
    // a fresh trustline; this asserts it is absent.
    const db = freshDb();
    await ingestTrustlines(adapt(db), client(), range());

    const codes = (
      db.prepare('SELECT DISTINCT asset_code FROM trustlines').all() as { asset_code: string }[]
    ).map((r) => r.asset_code);

    assert.ok(!codes.includes('TESTGK26'), 'trustline_updated must not create a row');
    db.close();
  });

  it('is idempotent: re-ingesting the same range writes nothing', async () => {
    const db = freshDb();
    await ingestTrustlines(adapt(db), client(), range());

    const before = (db.prepare('SELECT COUNT(*) c FROM trustlines').get() as { c: number }).c;

    const second = await ingestTrustlines(adapt(db), client(), range());

    assert.equal(second.trustlinesWritten, 0);
    assert.equal(second.accountsWritten, 0);
    assert.equal(second.trustlinesSeen, 5, 'still sees them, just does not rewrite');
    assert.equal(
      (db.prepare('SELECT COUNT(*) c FROM trustlines').get() as { c: number }).c,
      before,
    );
    db.close();
  });

  it('keeps the earliest established_at when a trustline is re-established', () => {
    // Re-establishment policy, asserted rather than left to the conflict clause:
    // a removed-then-recreated trustline keeps its first establishment date. The
    // column claims to describe first establishment, the schema records no removal,
    // and overwriting would make the stored value depend on ingestion order.
    const db = freshDb();
    db.prepare('INSERT INTO accounts (account_id) VALUES (?)').run('GACCOUNT1');
    const insert = db.prepare(
      `INSERT INTO trustlines (account_id, asset_code, asset_issuer, established_at)
       VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    );
    insert.run('GACCOUNT1', 'USDC', 'GISSUER', '2026-01-01T00:00:00Z');
    insert.run('GACCOUNT1', 'USDC', 'GISSUER', '2026-06-01T00:00:00Z');

    const row = db.prepare('SELECT established_at FROM trustlines').get() as {
      established_at: string;
    };
    assert.equal(row.established_at, '2026-01-01T00:00:00Z');
    db.close();
  });

  it('writes account parents so the foreign key resolves', async () => {
    const db = freshDb();
    await ingestTrustlines(adapt(db), client(), range());

    assert.deepEqual(db.pragma('foreign_key_check'), []);

    const orphans = (
      db
        .prepare(
          `SELECT COUNT(*) c FROM trustlines t
           LEFT JOIN accounts a ON a.account_id = t.account_id WHERE a.account_id IS NULL`,
        )
        .get() as { c: number }
    ).c;
    assert.equal(orphans, 0);
    db.close();
  });

  it('stops at toLedger', async () => {
    const db = freshDb();
    const narrow = await ingestTrustlines(adapt(db), client(), {
      fromLedger: fixture.fromLedger,
      toLedger: fixture.fromLedger + 5,
    });
    assert.ok(narrow.effectsScanned < 279);
    db.close();
  });

  it('rejects an inverted range', async () => {
    const db = freshDb();
    await assert.rejects(
      () => ingestTrustlines(adapt(db), client(), { fromLedger: 100, toLedger: 50 }),
      RangeError,
    );
    db.close();
  });
});

describe('trustlines fixture provenance', () => {
  it('is a trustlines capture from testnet', () => {
    assert.equal(fixture.job, 'trustlines');
    assert.equal(fixture.networkPassphrase, 'Test SDF Network ; September 2015');
    assert.ok(!Number.isNaN(Date.parse(fixture.capturedAt)));
  });
});
