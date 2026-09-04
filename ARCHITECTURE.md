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

## Schema (Phase 1, SQLite-compatible)

Normalized "raw" tables mirror Horizon's operation/effect model closely
enough to ingest directly, then a small set of analytical views sit on top.

```sql
CREATE TABLE ledgers (
  sequence          INTEGER PRIMARY KEY,
  closed_at         TEXT,     -- ISO8601
  operation_count   INTEGER
);

CREATE TABLE accounts (
  account_id        TEXT PRIMARY KEY
);

CREATE TABLE operations (
  id                TEXT PRIMARY KEY,   -- Horizon operation id
  ledger_sequence   INTEGER REFERENCES ledgers(sequence),
  type              TEXT,               -- payment, path_payment_strict_send, etc.
  source_account    TEXT REFERENCES accounts(account_id),
  created_at        TEXT                -- ISO8601
);

CREATE TABLE payments (
  operation_id      TEXT PRIMARY KEY REFERENCES operations(id),
  from_account      TEXT REFERENCES accounts(account_id),
  to_account        TEXT REFERENCES accounts(account_id),
  asset_code        TEXT,               -- 'native' for XLM
  asset_issuer      TEXT,               -- NULL for native
  amount            TEXT                -- stored as string, cast at query time
                                         -- (avoids float precision issues;
                                         -- Postgres phase moves this to NUMERIC)
);

CREATE TABLE trustlines (
  account_id        TEXT REFERENCES accounts(account_id),
  asset_code        TEXT,
  asset_issuer      TEXT,
  established_at    TEXT,               -- ISO8601
  PRIMARY KEY (account_id, asset_code, asset_issuer)
);

CREATE TABLE trades (
  id                  TEXT PRIMARY KEY,
  ledger_sequence     INTEGER REFERENCES ledgers(sequence),
  base_asset_code     TEXT,
  counter_asset_code  TEXT,
  base_amount         TEXT,
  counter_amount      TEXT,
  executed_at         TEXT                -- ISO8601
);
```

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

- Same logical schema, translated: `TEXT` amount columns become `NUMERIC`,
  `TEXT` timestamps become `TIMESTAMPTZ`.
- Migration tooling: a versioned migrations directory, applied via a
  minimal runner (not a heavy ORM) so both SQLite and Postgres can consume
  the same migration files with a small dialect shim.
- Analytical views become materialized views in Postgres, with a documented
  refresh strategy (`REFRESH MATERIALIZED VIEW CONCURRENTLY` on a cron
  cadence) — this is the point where the two backends genuinely diverge in
  behavior, and it's called out explicitly rather than papered over.
- Partitioning by ledger-sequence range is noted as a Phase 3+ concern, not
  implemented until data volume actually warrants it.

## Query API (Phase 3, stretch)

Read-only, thin layer over the views above. No write endpoints. Rate-limited
if made public. Explicitly out of scope for Phase 1–2 sign-off.

## Testing strategy

- Phase 1: ingest a real, fixed testnet ledger range (documented in the repo
  so results are reproducible), assert known values against the 5
  analytical views.
- No mocked Horizon responses standing in for real ingestion in Phase 1
  verification — Phase 1 sign-off means verified against real testnet data.
