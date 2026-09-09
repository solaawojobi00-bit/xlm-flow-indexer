# Architecture: xlm-flow-indexer

## Overview

Three layers: **ingestion** (pulls raw ledger data from Horizon), **storage**
(normalized + analytical schema, SQLite or Postgres), and **query** (SQL
views + optional read-only API). The schema is written to be portable
between SQLite and Postgres for as long as reasonably possible, with an
explicit, documented point where that portability breaks and Postgres-only
features take over.

## Why two databases, not one

- **SQLite** — local development, CI, and Phase 1 testnet verification. Zero
  setup, fast iteration, and a real constraint worth designing against: it
  forces the schema to stay simple and avoid premature reliance on
  Postgres-only features.
- **Postgres** — Phase 2 production target. Needed once the workload
  requires: concurrent writers (ingestion + query API running together),
  materialized views with concurrent refresh, window functions at scale,
  and eventually partitioning by ledger range as data grows.

This mirrors — and is informed by — the SQLite/serverless constraint
originally raised on `netpulse-xlm` (later found to not apply there, since
that project runs a long-lived process rather than serverless functions).
Here the Postgres migration isn't optional deferred work — it's Phase 2 by
design, because ledger history only grows and analytical queries get
expensive over normalized data at scale.

## Schema (dual-dialect: SQLite and Postgres)

Normalized "raw" tables mirror Horizon's operation/effect model closely
enough to ingest directly, then a small set of analytical views sit on top.

One set of numbered migration files in `src/db/migrations/` serves both
engines. Where the dialects genuinely differ the file carries a `${...}` token
that `src/db/dialect.ts` expands per engine, so there is no SQLite copy and
Postgres copy to drift apart. Four tokens exist, because only four things
differ:

| Token | SQLite | Postgres |
| --- | --- | --- |
| `${amountType}` | `TEXT` | `NUMERIC(19, 7)` |
| `${timestampType}` | `TEXT` | `TIMESTAMPTZ` |
| `${day(expr)}` | `date(expr)` | `(expr)::date` |
| `${amount(expr)}` | `CAST(expr AS REAL)` | `expr` |

Everything else — `TEXT` account ids, `INTEGER` ledger sequences, `||`
concatenation, `UNION ALL`, `WITH`, the aggregate functions — is portable SQL
and is written plainly.

`NUMERIC(19, 7)` is not arbitrary: a Stellar amount is an int64 count of
stroops at 1e-7, so the largest representable value is `922337203685.4775807`
— twelve integer digits and seven fractional. That is the precision the
protocol can produce, so it is the precision the column declares. The
`${amount(...)}` token exists because SQLite has to cast a TEXT column to
aggregate it, whereas in Postgres the column is already NUMERIC and casting
would round-trip an exact decimal through a float — the exact loss the
translation is meant to prevent.

The SQL block below is the **SQLite** rendering; substitute the table above for
the Postgres one.

```sql
CREATE TABLE ledgers (
  sequence          INTEGER PRIMARY KEY,
  closed_at         TEXT    NOT NULL,   -- ISO8601 (UTC)
  operation_count   INTEGER NOT NULL
);

CREATE TABLE accounts (
  account_id        TEXT PRIMARY KEY
);

CREATE TABLE operations (
  id                TEXT PRIMARY KEY,   -- Horizon operation id
  ledger_sequence   INTEGER NOT NULL REFERENCES ledgers(sequence),
  type              TEXT    NOT NULL,   -- payment, path_payment_strict_send, etc.
  source_account    TEXT    NOT NULL REFERENCES accounts(account_id),
  created_at        TEXT    NOT NULL    -- ISO8601 (UTC)
);

CREATE TABLE payments (
  operation_id      TEXT PRIMARY KEY REFERENCES operations(id),
  from_account      TEXT NOT NULL REFERENCES accounts(account_id),
  to_account        TEXT NOT NULL REFERENCES accounts(account_id),
  asset_code        TEXT NOT NULL,          -- 'native' for XLM
  asset_issuer      TEXT NOT NULL DEFAULT '',  -- '' for native, never NULL
  amount            TEXT NOT NULL           -- stored as string, cast at query time
                                            -- (avoids float precision issues;
                                            -- Postgres phase moves this to NUMERIC)
);

CREATE TABLE trustlines (
  account_id        TEXT NOT NULL REFERENCES accounts(account_id),
  asset_code        TEXT NOT NULL,
  asset_issuer      TEXT NOT NULL DEFAULT '',  -- '' for native, never NULL
  established_at    TEXT NOT NULL,          -- ISO8601 (UTC)
  PRIMARY KEY (account_id, asset_code, asset_issuer)
);

CREATE TABLE trades (
  id                    TEXT PRIMARY KEY,
  ledger_sequence       INTEGER NOT NULL REFERENCES ledgers(sequence),
  base_asset_code       TEXT NOT NULL,
  base_asset_issuer     TEXT NOT NULL DEFAULT '',  -- '' for native
  counter_asset_code    TEXT NOT NULL,
  counter_asset_issuer  TEXT NOT NULL DEFAULT '',  -- '' for native
  base_amount           TEXT NOT NULL,
  counter_amount        TEXT NOT NULL,
  executed_at           TEXT NOT NULL       -- ISO8601 (UTC)
);
```

### Why `asset_issuer` is `''` for native and never `NULL`

The obvious encoding for "this asset has no issuer" is `NULL`, but it cannot be
used here. SQLite does not enforce uniqueness across `NULL` columns in a
non-`INTEGER` primary key, so with a nullable issuer the row
`(account, 'native', NULL)` can be inserted into `trustlines` without limit — the
primary key that the whole idempotency guarantee rests on simply does not hold for
the most common asset on the network.

Postgres behaves the opposite way: `PRIMARY KEY` implies `NOT NULL`, so the same
insert errors outright. Encoding native as `NULL` would therefore let Phase 1
silently accumulate duplicates that the Phase 2 migration parity check rejects,
with the two backends disagreeing about whether the data was ever valid.

Now that both dialects are implemented, the consequence is worth stating
precisely. On `trustlines.asset_issuer` — a primary key column — the explicit
`NOT NULL` is **redundant in Postgres and load-bearing in SQLite**. It is kept
because one schema serves both engines and it is harmless in the one that does
not need it. On `payments.asset_issuer` and the two `trades` issuer columns it
is not redundant in either engine, because those columns are not part of a
primary key. Both halves are asserted against a live Postgres in
`test/postgres.test.ts`, not just against the DDL text.

Using `''` consistently in `payments`, `trustlines` and `trades` keeps one code
path, holds in both engines, and makes `payments(asset_code, asset_issuer)` a total
key. The repository carries a regression test that asserts both halves of this: that
the shipped schema rejects a duplicate native trustline, and that the nullable-issuer
form accepts one.

### Why `trades` carries issuer columns

A Stellar asset is identified by code *and* issuer, so `base_asset_code` alone is
not an asset identity. Without the issuer columns, `trade_pair_activity` would group
two different `USDC` issuers into a single pair row with summed volume — an error
that produces plausible-looking numbers on a small ledger range — and `trades` could
not be joined to `payments` on asset identity at all. Horizon's `/trades` response
already returns both issuers, so carrying them costs nothing at ingestion time.

### Migration tracking

Applied migrations are recorded in a `schema_migrations` table (`version`, `name`,
`checksum`, `applied_at`). The checksum is what makes editing an already-applied
migration a hard error rather than a silent divergence between the repository and a
live database.

Indexes (Phase 1): `payments(from_account)`, `payments(to_account)`,
`payments(asset_code, asset_issuer)`, `operations(created_at)`,
`trades(executed_at)`.

## Analytical views (Phase 1)

At least 5, built as SQL views (not application code) so they're portable
and independently testable:

1. `account_flow_daily` — net in/out per account per asset per day.
2. `asset_velocity` — transfer count and volume per asset over a rolling
   window.
3. `anchor_payment_volume` — payment volume grouped by known anchor issuer
   accounts (issuer list config-driven, not hardcoded).
4. `trade_pair_activity` — trade count/volume per asset pair.
5. `top_accounts_by_volume` — ranked accounts by total payment volume in a
   given window.

## Ingestion pipeline (Phase 1: polling)

- A poll loop against Horizon's `/operations` and `/trades` endpoints,
  cursor-based (Horizon's paging token), writing into the raw tables above.
- Idempotent by primary key — re-running a poll over an already-ingested
  range is a no-op, not a duplicate-row bug. This matters for both CI
  re-runs and for the eventual move to incremental cron ingestion in
  Phase 2.
- No streaming/websocket ingestion in Phase 1. That's explicitly deferred —
  see Non-Goals in PRD.md.

## SQLite → Postgres migration path (Phase 2)

- **Done (#48)** — Same logical schema, translated: `TEXT` amount columns
  become `NUMERIC(19, 7)`, `TEXT` timestamps become `TIMESTAMPTZ`. See the
  token table under [Schema](#schema-dual-dialect-sqlite-and-postgres).
- **Done (#48)** — Migration tooling: a versioned migrations directory,
  applied via a minimal runner (not a heavy ORM) so both SQLite and Postgres
  consume the same migration files with a small dialect shim.
  `migrate --db <path>` targets SQLite, `migrate --postgres <url>` targets
  Postgres. Migration checksums are taken over the *rendered* SQL, so each
  engine records what was actually applied to it, and introducing the shim did
  not invalidate any already-migrated SQLite database.
- Analytical views become materialized views in Postgres, with a documented
  refresh strategy (`REFRESH MATERIALIZED VIEW CONCURRENTLY` on a cron
  cadence) — this is the point where the two backends genuinely diverge in
  behavior, and it's called out explicitly rather than papered over. Tracked
  in #51; the views are still plain `CREATE VIEW` in both engines today.
- Partitioning by ledger-sequence range is noted as a Phase 3+ concern, not
  implemented until data volume actually warrants it.

### What is not yet dual-dialect

The **schema and its migrations** run on both engines. The **ingestion jobs do
not**: `openDb` returns a `better-sqlite3` handle and the jobs in `src/ingest/`
use its synchronous prepared-statement API throughout, so `ingest` is
SQLite-only. Making it engine-agnostic means an async data-access seam through
every job, which is a larger change than the schema translation and is
deliberately not bundled into it. Until then, the Postgres path is for schema
creation and for the migration/parity work in #53 — not for live ingestion.

## Query API (Phase 3, stretch)

Read-only, thin layer over the views above. No write endpoints. Rate-limited
if made public. Explicitly out of scope for Phase 1–2 sign-off.

## Testing strategy

- Phase 1: ingest a real, fixed testnet ledger range (documented in the repo
  so results are reproducible), assert known values against the 5
  analytical views.
- No mocked Horizon responses standing in for real ingestion in Phase 1
  verification — Phase 1 sign-off means verified against real testnet data.
