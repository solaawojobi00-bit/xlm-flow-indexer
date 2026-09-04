# Backlog: xlm-flow-indexer

Issues are labeled with relative effort — **[Trivial]**, **[Medium]**,
**[High]** — as a rough sizing signal only.

## Phase 1 — Core schema + SQLite ingestion (testnet-verified)

1. **[High]** Design and commit initial SQLite schema (ledgers, accounts,
   operations, payments, trustlines, trades) with migration files.
2. **[Medium]** Horizon client wrapper: cursor-based paging, retry/backoff,
   rate-limit handling.
3. **[High]** Payments ingestion job: poll `/operations`, filter to
   payment-type ops, write idempotently into `payments` + `operations`.
4. **[Medium]** Trustlines ingestion job: derive trustline establishment
   events from account/effects data.
5. **[High]** Trades ingestion job: poll `/trades`, write into `trades`
   table.
6. **[Medium]** Idempotency test suite: re-running ingestion over an
   already-ingested range produces zero duplicate rows.
7. **[Medium]** `account_flow_daily` view + tests against real testnet data.
8. **[Medium]** `asset_velocity` view + tests against real testnet data.
9. **[Medium]** `anchor_payment_volume` view (config-driven issuer list) +
   tests.
10. **[Medium]** `trade_pair_activity` view + tests.
11. **[Medium]** `top_accounts_by_volume` view + tests.
12. **[Trivial]** CLI entrypoint: run ingestion for a given ledger range
    from the command line.
13. **[Trivial]** README: setup, schema overview, how to run Phase 1
    ingestion against testnet.
14. **[Medium]** CI: lint + schema migration check + view test suite on
    every PR.
15. **[Trivial]** Indexing pass: confirm/add indexes listed in
    ARCHITECTURE.md, add EXPLAIN-based regression check for the 5 core
    views.

## Phase 2 — Postgres support + incremental ingestion

16. **[High]** Postgres schema translation (NUMERIC/TIMESTAMPTZ) + dialect
    shim for shared migration files.
17. **[High]** Convert the 5 analytical views to materialized views with a
    documented, tested refresh strategy.
18. **[Medium]** Incremental ingestion: cron/poll-based delta ingestion
    instead of full re-ingest, with a documented backfill procedure.
19. **[Medium]** Migration runbook + dry-run tooling: move a populated
    SQLite dataset to Postgres and verify row-count/value parity.
20. **[Trivial]** Branch protection + CI job naming pass on `main`
    (consistent with conventions used on `netpulse-xlm`).

## Phase 3 — Stretch

- Read-only query API over the materialized views, rate-limited.
- Soroban contract event ingestion.
- Streaming/websocket ingestion path (explicitly deferred from Phase 1–2).
