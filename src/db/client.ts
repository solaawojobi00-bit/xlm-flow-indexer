import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenOptions {
  /** Open the database read-only. Fails if the file does not exist. */
  readonly readonly?: boolean;
}

/**
 * Open a SQLite database with the pragmas this project depends on.
 *
 * `foreign_keys` is off by default in SQLite and is a per-connection setting, not
 * a property of the file. Without it, every REFERENCES clause in the schema is
 * inert and the ingestion jobs can write orphan rows that no later check would
 * catch. Setting it here means no caller has to remember to.
 */
export function openDb(path: string, options: OpenOptions = {}): Db {
  const db = new Database(path, options.readonly ? { readonly: true } : {});

  db.pragma('foreign_keys = ON');

  if (!options.readonly) {
    // WAL lets a reader run concurrently with the ingestion writer, which the
    // Phase 3 query API needs and which makes local development less annoying.
    // Not available for in-memory databases, which is fine: nothing concurrent
    // reads those.
    if (path !== ':memory:') {
      db.pragma('journal_mode = WAL');
    }
    // Wait rather than throwing SQLITE_BUSY the instant another writer holds the
    // lock. Ingestion runs in batches and a short wait is preferable to a crash.
    db.pragma('busy_timeout = 5000');
  }

  return db;
}
