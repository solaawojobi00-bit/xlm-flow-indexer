import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parseCliArgs, runCli } from '../src/cli.ts';
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
