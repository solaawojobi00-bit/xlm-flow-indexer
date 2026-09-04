// Minimal migrate entrypoint so the schema can be applied before the full CLI
// exists. Issue #12 replaces this with a proper CLI carrying `migrate` as a
// subcommand alongside `ingest`.

import { openDb } from '../db/client.ts';
import { migrate } from '../db/migrate.ts';

function main(argv: string[]): number {
  const path = argv[0];
  if (!path || path === '--help' || path === '-h') {
    console.log('Usage: node src/cli/migrate.ts <path-to-sqlite-db>');
    return path ? 0 : 1;
  }

  const db = openDb(path);
  try {
    const applied = migrate(db);
    if (applied.length === 0) {
      console.log('No pending migrations.');
    } else {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

process.exit(main(process.argv.slice(2)));
