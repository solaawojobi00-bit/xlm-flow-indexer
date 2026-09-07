import { readFileSync } from 'node:fs';

import type { Db } from './client.ts';

export interface AnchorIssuerConfig {
  readonly account_id: string;
  readonly name?: string;
  readonly home_domain?: string;
}

/**
 * Populates the `anchor_issuers` table from a JSON config file path or config objects.
 *
 * Runs idempotently via `INSERT ... ON CONFLICT DO UPDATE`.
 * Rejects empty-string `account_id` to prevent accidental matching against native assets.
 *
 * @returns Number of anchor issuers processed.
 */
export function loadAnchorIssuers(
  db: Db,
  configOrPath: string | readonly AnchorIssuerConfig[],
): number {
  let entries: readonly AnchorIssuerConfig[];

  if (typeof configOrPath === 'string') {
    const raw = readFileSync(configOrPath, 'utf8');
    entries = JSON.parse(raw) as AnchorIssuerConfig[];
  } else {
    entries = configOrPath;
  }

  const upsert = db.prepare(`
    INSERT INTO anchor_issuers (account_id, name, home_domain)
    VALUES (?, ?, ?)
    ON CONFLICT (account_id) DO UPDATE SET
      name = excluded.name,
      home_domain = excluded.home_domain
  `);

  const runAll = db.transaction(() => {
    for (const entry of entries) {
      if (!entry.account_id || entry.account_id.trim() === '') {
        throw new Error('Anchor issuer account_id cannot be empty.');
      }
      upsert.run(entry.account_id.trim(), entry.name ?? null, entry.home_domain ?? null);
    }
  });

  runAll();
  return entries.length;
}
