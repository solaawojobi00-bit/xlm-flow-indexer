import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { POSTGRES, SQLITE, dialectFor, render } from '../src/db/dialect.ts';
import { MIGRATIONS_DIR, loadMigrations } from '../src/db/migrate.ts';

/**
 * Dialect shim suite (issue #48).
 *
 * The shim's job is to let one set of numbered migration files apply to both
 * SQLite and Postgres. Two properties matter, and they pull in opposite
 * directions:
 *
 *   1. The Postgres output must actually be translated — NUMERIC amounts,
 *      TIMESTAMPTZ timestamps, `::date` day bucketing.
 *   2. The SQLite output must be byte-for-byte what it was before the shim
 *      existed, because migration checksums are taken over the rendered SQL.
 *      Any drift there would make every already-applied migration on an
 *      existing database look tampered with and refuse to run.
 */

const raw = (file: string): string => readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

/**
 * A rendered migration with its `--` comment lines removed.
 *
 * Needed because the migration headers discuss the dialect difference in prose
 * — 003 explains the SQLite `date(created_at)` bucketing and the
 * `CAST(amount AS REAL)` convention — so a naive search for those strings finds
 * the documentation rather than the SQL. Assertions about what the *executable*
 * SQL does have to look past the comments.
 *
 * Those headers are deliberately not rewritten to describe the shim: the SQLite
 * render has to stay byte-identical to keep migration checksums stable, and
 * comment text is part of the rendered bytes. See ARCHITECTURE.md.
 */
const codeOf = (file: string, dialect: typeof SQLITE): string =>
  render(raw(file), dialect)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

describe('SQLite rendering is unchanged by the shim', () => {
  /**
   * Checksums of the seven migrations as they were before tokenisation,
   * captured from the pre-shim tree.
   *
   * Hard coded rather than recomputed. The whole point is to compare against
   * what a *previously migrated database* recorded, so deriving these from the
   * current files would make the assertion vacuous — it would pass no matter
   * how the SQLite output drifted.
   */
  const PRE_SHIM_CHECKSUMS: Readonly<Record<string, string>> = {
    '001_init.sql': '1cbb5242d0a5441ac8ab68cc89032a89913842815db6b67db3d261dd6772c5b1',
    '002_trade_type.sql': '47bc267ddf9dae31b83108c738247beb7029037cab5d0a4fe84bc5755b8d9dee',
    '003_account_flow_daily.sql':
      '1fca5d63cdea6a882e70f0e730622d61236ab1bb3676d15cf44e3ce6a8edca19',
    '004_asset_velocity.sql': '4c5c393ba8ef51ad28658825e5934343ed89780feace19f9d5c4acd6ab8d99bc',
    '005_anchor_payment_volume.sql':
      'c1f4141fb742b58210cff57b9e8ef6fb39acdcff181ccedd3850a7554ae8e75b',
    '006_trade_pair_activity.sql':
      '9018223f6b9ea6e178b3eedb575be0c375ffb9189f5be54a480a38a985f1896e',
    '007_top_accounts_by_volume.sql':
      'd166faba3c23dd30a504f81b74a9b882525f0f802b22521edb468195c491d9b4',
  };

  const checksumOf = (sql: string): string =>
    createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

  it('reproduces every pre-shim checksum exactly', () => {
    for (const [file, expected] of Object.entries(PRE_SHIM_CHECKSUMS)) {
      assert.equal(
        checksumOf(render(raw(file), SQLITE)),
        expected,
        `${file} renders differently than it did before the shim — every SQLite ` +
          'database that already applied it would now refuse to migrate',
      );
    }
  });

  it('is the checksum the migration loader actually reports', () => {
    // Guards the wiring as well as the rendering: loadMigrations defaults to
    // SQLite, and it is its checksum that gets written to schema_migrations.
    for (const migration of loadMigrations()) {
      const file = `${String(migration.version).padStart(3, '0')}_${migration.name}.sql`;
      assert.equal(migration.checksum, PRE_SHIM_CHECKSUMS[file], `${file} via loadMigrations`);
    }
  });

  it('covers every migration on disk', () => {
    // Without this, adding an eighth migration and forgetting to pin it would
    // leave a silent hole in the guarantee above.
    assert.deepEqual(
      loadMigrations()
        .map((m) => `${String(m.version).padStart(3, '0')}_${m.name}.sql`)
        .sort(),
      Object.keys(PRE_SHIM_CHECKSUMS).sort(),
    );
  });
});

describe('Postgres type translation', () => {
  it('translates amount columns to NUMERIC(19, 7)', () => {
    const sql = render(raw('001_init.sql'), POSTGRES);

    // 19 significant digits: a Stellar amount is an int64 stroop count at 1e-7,
    // so 922337203685.4775807 is the largest representable value.
    assert.match(sql, /amount {12}NUMERIC\(19, 7\) NOT NULL/);
    assert.match(sql, /base_amount {11}NUMERIC\(19, 7\) NOT NULL/);
    assert.match(sql, /counter_amount {8}NUMERIC\(19, 7\) NOT NULL/);
    assert.doesNotMatch(sql, /amount\s+TEXT/, 'no amount column may stay TEXT');
  });

  it('translates timestamp columns to TIMESTAMPTZ', () => {
    const sql = render(raw('001_init.sql'), POSTGRES);

    for (const column of ['closed_at', 'created_at', 'established_at', 'executed_at']) {
      assert.match(sql, new RegExp(`${column}\\s+TIMESTAMPTZ`), `${column} must be TIMESTAMPTZ`);
      assert.doesNotMatch(sql, new RegExp(`${column}\\s+TEXT`), `${column} must not stay TEXT`);
    }
  });

  it('leaves genuinely textual columns as TEXT', () => {
    // The translation is targeted, not a blanket TEXT rewrite. Account ids,
    // asset codes, operation ids and the operation type are strings in both
    // engines, and turning them into anything else would be a real bug.
    const sql = render(raw('001_init.sql'), POSTGRES);

    for (const column of [
      'account_id',
      'asset_code',
      'asset_issuer',
      'source_account',
      'from_account',
      'to_account',
      'base_asset_code',
      'counter_asset_issuer',
    ]) {
      assert.match(sql, new RegExp(`${column}\\s+TEXT`), `${column} must stay TEXT`);
    }
  });

  it('keeps ledger sequences and the trades type column intact', () => {
    const sql = render(raw('001_init.sql'), POSTGRES);
    assert.match(sql, /sequence {10}INTEGER PRIMARY KEY/);
    assert.match(sql, /ledger_sequence {3}INTEGER NOT NULL REFERENCES ledgers\(sequence\)/);
  });
});

describe('Postgres expression translation', () => {
  const VIEW_MIGRATIONS = [
    '003_account_flow_daily.sql',
    '004_asset_velocity.sql',
    '005_anchor_payment_volume.sql',
    '006_trade_pair_activity.sql',
    '007_top_accounts_by_volume.sql',
  ];

  it('buckets days with ::date instead of SQLite date()', () => {
    assert.match(codeOf('003_account_flow_daily.sql', POSTGRES), /\(o\.created_at\)::date AS day/);

    for (const file of VIEW_MIGRATIONS) {
      assert.doesNotMatch(
        codeOf(file, POSTGRES),
        /\bdate\(/,
        `${file} must not call SQLite's date() in Postgres SQL`,
      );
    }
  });

  it('reads NUMERIC amounts directly rather than casting to REAL', () => {
    // Casting a NUMERIC through REAL would round-trip an exact decimal via a
    // float, which is precisely what moving to NUMERIC was meant to stop.
    for (const file of VIEW_MIGRATIONS) {
      assert.doesNotMatch(
        codeOf(file, POSTGRES),
        /CAST\([^)]*AS REAL\)/,
        `${file} must not cast to REAL`,
      );
    }

    assert.match(codeOf('003_account_flow_daily.sql', POSTGRES), /p\.amount AS outbound/);
    assert.match(codeOf('004_asset_velocity.sql', POSTGRES), /SUM\(p\.amount\) AS total_volume/);
  });

  it('still casts, and still calls date(), in SQLite', () => {
    // The other half of the shim: the SQLite output must keep doing what it did
    // before, because there the column really is TEXT.
    assert.match(
      codeOf('003_account_flow_daily.sql', SQLITE),
      /CAST\(p\.amount AS REAL\) AS outbound/,
    );
    assert.match(codeOf('003_account_flow_daily.sql', SQLITE), /date\(o\.created_at\) AS day/);
    assert.doesNotMatch(codeOf('003_account_flow_daily.sql', SQLITE), /::date/);
  });
});

describe('the #1 schema amendments under Postgres', () => {
  /**
   * Issue #48 asks for both amendments from issue #1 to be re-verified in the
   * translated schema. These assert the *rendered DDL*; that Postgres actually
   * enforces them is asserted against a live server in postgres.test.ts.
   */
  it('keeps asset_issuer NOT NULL DEFAULT %s on all three tables', () => {
    const sql = render(raw('001_init.sql'), POSTGRES);
    const matches = sql.match(/asset_issuer\s+TEXT NOT NULL DEFAULT ''/g) ?? [];

    // payments.asset_issuer, trustlines.asset_issuer, trades.base_asset_issuer
    // and trades.counter_asset_issuer.
    assert.equal(matches.length, 4, 'all four issuer columns keep the empty-string encoding');
  });

  it('keeps the trustlines primary key spanning asset_issuer', () => {
    // In Postgres a PRIMARY KEY column is NOT NULL implicitly, so the explicit
    // NOT NULL on trustlines.asset_issuer is redundant here rather than newly
    // necessary -- the reason it exists is SQLite, which does not enforce
    // uniqueness across NULLs in a non-INTEGER primary key. It is kept because
    // one schema serves both engines, and it is harmless in Postgres.
    assert.match(
      render(raw('001_init.sql'), POSTGRES),
      /PRIMARY KEY \(account_id, asset_code, asset_issuer\)/,
    );
  });

  it('keeps both issuer columns on trades', () => {
    const sql = render(raw('001_init.sql'), POSTGRES);
    assert.match(sql, /base_asset_issuer\s+TEXT NOT NULL/);
    assert.match(sql, /counter_asset_issuer\s+TEXT NOT NULL/);
  });
});

describe('token expansion is total', () => {
  it('leaves no token behind for either dialect', () => {
    for (const dialect of [SQLITE, POSTGRES]) {
      for (const migration of loadMigrations(MIGRATIONS_DIR, dialect)) {
        assert.doesNotMatch(
          migration.sql,
          /\$\{/,
          `migration ${migration.version} still holds a token after rendering for ${dialect.name}`,
        );
      }
    }
  });

  it('rejects an unknown bare token', () => {
    assert.throws(
      () => render('SELECT ${nope} FROM t', SQLITE),
      /Unknown dialect token "\$\{nope\}"/,
    );
  });

  it('rejects a token with an empty argument', () => {
    assert.throws(() => render('SELECT ${day()} FROM t', SQLITE), /given an empty argument/);
  });

  it('rejects a token whose argument contains parentheses', () => {
    // The argument grammar deliberately excludes nested parens, so this does
    // not match CALL_TOKEN and survives to the leftover check.
    assert.throws(
      () => render('SELECT ${day(foo(bar))} FROM t', SQLITE),
      /Unexpanded dialect token/,
    );
  });

  it('rejects an unclosed token', () => {
    assert.throws(() => render('SELECT ${day(x} FROM t', SQLITE), /Unexpanded dialect token/);
  });
});

describe('dialectFor', () => {
  it('resolves both engine names', () => {
    assert.equal(dialectFor('sqlite').name, 'sqlite');
    assert.equal(dialectFor('postgres').name, 'postgres');
  });

  it('rejects anything else by name', () => {
    assert.throws(() => dialectFor('mysql'), /Unknown SQL dialect "mysql"/);
  });
});
