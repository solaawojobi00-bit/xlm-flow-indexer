import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseCliArgs, redactConnectionString, runCli } from '../src/cli.ts';
import { openDb } from '../src/db/client.ts';
import { appliedMigrations } from '../src/db/migrate.ts';
import { loadFixture, startFixtureServer, type FixtureServer } from './helpers/fixture-server.ts';

const paymentsFixture = loadFixture('testnet-payments-4539850-4539862');
let server: FixtureServer;
let scratchDir: string;

before(async () => {
  server = await startFixtureServer(paymentsFixture);
  scratchDir = mkdtempSync(join(tmpdir(), 'xlm-cli-test-'));
});

after(async () => {
  await server.close();
  rmSync(scratchDir, { recursive: true, force: true });
});

function tempDbPath(): string {
  return join(scratchDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Run the CLI with stderr captured, so a message can be asserted on. */
async function captureErrors(run: () => Promise<number>): Promise<{ code: number; text: string }> {
  let text = '';
  const original = console.error;
  console.error = (msg: string) => {
    text += `${msg}\n`;
  };

  try {
    return { code: await run(), text };
  } finally {
    console.error = original;
  }
}

describe('CLI argument parsing', () => {
  it('parses migrate command with db flag', () => {
    const parsed = parseCliArgs(['migrate', '--db', './my.db']);
    assert.equal(parsed.command, 'migrate');
    assert.equal(parsed.db, './my.db');
  });

  it('parses ingest command with range and options', () => {
    const parsed = parseCliArgs([
      'ingest',
      '--from',
      '100',
      '--to',
      '200',
      '--db',
      './indexer.db',
      '--horizon',
      'http://localhost:8000',
      '--jobs',
      'payments,trades',
    ]);

    assert.equal(parsed.command, 'ingest');
    assert.equal(parsed.from, 100);
    assert.equal(parsed.to, 200);
    assert.equal(parsed.db, './indexer.db');
    assert.equal(parsed.horizon, 'http://localhost:8000');
    assert.deepEqual(parsed.jobs, ['payments', 'trades']);
  });

  it('defaults jobs to all three when omitted', () => {
    const parsed = parseCliArgs(['ingest', '--from', '10', '--to', '20', '--db', './db.sqlite']);
    assert.deepEqual(parsed.jobs, ['payments', 'trustlines', 'trades']);
  });

  it('supports boolean job flags', () => {
    const parsed = parseCliArgs([
      'ingest',
      '--payments',
      '--db',
      './db.sqlite',
      '--from',
      '1',
      '--to',
      '2',
    ]);
    assert.deepEqual(parsed.jobs, ['payments']);
  });

  it('rejects unknown jobs in --jobs list', () => {
    assert.throws(() => {
      parseCliArgs(['ingest', '--jobs', 'payments,foo']);
    }, /Unknown job "foo"/);
  });

  it('parses --postgres on ingest', () => {
    const parsed = parseCliArgs([
      'ingest',
      '--from',
      '1',
      '--to',
      '2',
      '--postgres',
      'postgres://localhost:5432/xlm',
    ]);
    assert.equal(parsed.postgres, 'postgres://localhost:5432/xlm');
    assert.equal(parsed.db, undefined);
  });

  it('parses --postgres on poll, including the = form', () => {
    const parsed = parseCliArgs(['poll', '--postgres=postgres://localhost:5432/xlm', '--once']);
    assert.equal(parsed.postgres, 'postgres://localhost:5432/xlm');
    assert.equal(parsed.once, true);
  });
});

describe('redactConnectionString', () => {
  it('masks the password', () => {
    // Every command prints the database it is about to write to. For Postgres
    // that string routinely carries credentials, and the banner goes to terminal
    // scrollback and CI logs.
    assert.equal(
      redactConnectionString('postgres://user:hunter2@db.example.com:5432/xlm'),
      'postgres://user:***@db.example.com:5432/xlm',
    );
  });

  it('leaves a credential-free string readable', () => {
    assert.equal(
      redactConnectionString('postgres://localhost:5432/xlm'),
      'postgres://localhost:5432/xlm',
    );
  });

  it('keeps the username, which is not the secret', () => {
    assert.equal(
      redactConnectionString('postgres://reader@localhost:5432/xlm'),
      'postgres://reader@localhost:5432/xlm',
    );
  });

  it('refuses to echo a string it could not parse', () => {
    // The reason parsing failed might be the password, so passing the original
    // through as a fallback would defeat the point of redacting at all.
    assert.equal(redactConnectionString('not a url'), '<unparseable connection string>');
  });
});

describe('CLI command execution', () => {
  it('prints help text on --help and exits 0', async () => {
    let output = '';
    const origLog = console.log;
    console.log = (msg: string) => {
      output += msg;
    };

    try {
      const code = await runCli(['--help']);
      assert.equal(code, 0);
      assert.ok(output.includes('Usage:'));
      assert.ok(output.includes('migrate'));
      assert.ok(output.includes('ingest'));
      assert.ok(output.includes('--from'));
      assert.ok(output.includes('--to'));
      assert.ok(output.includes('--db'));
    } finally {
      console.log = origLog;
    }
  });

  it('runs migrate subcommand and applies schema migrations', async () => {
    const dbPath = tempDbPath();
    const code = await runCli(['migrate', '--db', dbPath]);
    assert.equal(code, 0);

    const db = openDb(dbPath);
    try {
      const applied = appliedMigrations(db);
      assert.ok(applied.length >= 7, 'all Phase 1 migrations should be applied');
    } finally {
      db.close();
    }
  });

  it('fails migrate with non-zero exit code when --db is missing', async () => {
    const code = await runCli(['migrate']);
    assert.equal(code, 1);
  });

  it('fails ingest with non-zero exit code on inverted ledger range', async () => {
    const dbPath = tempDbPath();
    const code = await runCli(['ingest', '--from', '200', '--to', '100', '--db', dbPath]);
    assert.equal(code, 1);
  });

  it('fails ingest with non-zero exit code on non-numeric or missing range', async () => {
    const dbPath = tempDbPath();
    const code1 = await runCli(['ingest', '--from', 'abc', '--to', '100', '--db', dbPath]);
    assert.equal(code1, 1);

    const code2 = await runCli(['ingest', '--db', dbPath]);
    assert.equal(code2, 1);
  });

  it('documents --postgres for every command that accepts it', async () => {
    let output = '';
    const origLog = console.log;
    console.log = (msg: string) => {
      output += msg;
    };

    try {
      await runCli(['--help']);
    } finally {
      console.log = origLog;
    }

    // Three occurrences: one under each of migrate, ingest and poll.
    assert.equal(output.split('--postgres <url>').length - 1, 3);
  });

  it('rejects --db and --postgres together on every command', async () => {
    // The rule migrate has had since #48, now inherited rather than re-derived.
    for (const command of ['migrate', 'ingest', 'poll']) {
      const errors = await captureErrors(() =>
        runCli([command, '--db', './x.db', '--postgres', 'postgres://localhost/xlm']),
      );
      assert.equal(errors.code, 1, command);
      assert.match(errors.text, /Pass either --db or --postgres, not both/, command);
    }
  });

  it('rejects neither --db nor --postgres on every command', async () => {
    for (const [command, args] of [
      ['migrate', []],
      ['ingest', ['--from', '1', '--to', '2']],
      ['poll', ['--once']],
    ] as const) {
      const errors = await captureErrors(() => runCli([command, ...args]));
      assert.equal(errors.code, 1, command);
      assert.match(errors.text, /one of --db <path> or --postgres <url>/, command);
    }
  });

  it('reports a Postgres connection failure rather than throwing', async () => {
    // Port 1 is not a Postgres server. The point is the exit code and the
    // message, not the driver's own error text.
    const errors = await captureErrors(() =>
      runCli(['migrate', '--postgres', 'postgres://user:secret@127.0.0.1:1/nope']),
    );

    assert.equal(errors.code, 1);
    assert.match(errors.text, /Migration failed: could not open/);
    assert.doesNotMatch(errors.text, /secret/, 'the password must not reach the log');
  });

  it('runs ingest across a range against fixture server', async () => {
    const dbPath = tempDbPath();
    const code = await runCli([
      'ingest',
      '--from',
      String(paymentsFixture.fromLedger),
      '--to',
      String(paymentsFixture.toLedger),
      '--db',
      dbPath,
      '--horizon',
      server.baseUrl,
      '--payments',
    ]);

    assert.equal(code, 0);

    const db = openDb(dbPath);
    try {
      const count = (db.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c;
      assert.equal(count, 8);
    } finally {
      db.close();
    }
  });
});
