# xlm-flow-indexer

A lightweight, self-hostable indexer that pulls Stellar ledger data out of Horizon
into a relational schema built for analytical SQL.

> **Status: early development.** The schema and ingestion pipeline are being built
> out under Phase 1. Nothing here is usable yet — there is no published release and
> no working setup path. Setup and usage instructions land once the CLI and the
> analytical views exist.

## The problem

Answering historical questions about Stellar activity — how an account's asset flow
has changed over the last 90 days, what payment volume moved through a given anchor
this month, which assets see the most path-payment routing — currently means standing
up your own Horizon ingestion pipeline.

Horizon is not built for that. It is an operational API rather than an analytical
store, and complex aggregate queries against it are slow or simply not expressible.
This project fills that gap: ingest once, then query with ordinary SQL.

It complements Horizon rather than replacing it. There is no attempt at operational
parity — no transaction submission, no transaction building.

## How it works

Three layers:

- **Ingestion** — polls Horizon's `/operations`, `/effects` and `/trades` endpoints
  using cursor-based paging, and writes into normalized raw tables. Idempotent by
  primary key, so re-running over an already-ingested range is a no-op rather than a
  source of duplicate rows.
- **Storage** — a normalized schema designed for aggregate queries. SQLite for local
  development, CI and Phase 1 verification; Postgres as the Phase 2 production target,
  from the same schema and ingestion code.
- **Query** — the analytical work lives in SQL views rather than application code, so
  it is portable between both backends and independently testable.

## Data model

Six raw tables mirror Horizon's operation and effect model closely enough to ingest
directly: `ledgers`, `accounts`, `operations`, `payments`, `trustlines` and `trades`.
The analytical views sit on top of these.

Amounts are stored as text exactly as Horizon returns them and cast at query time,
which avoids the precision loss that comes from round-tripping decimal values through
a float. Timestamps are stored as ISO8601 UTC.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full schema and the reasoning behind it.

## Analytical views

Five views ship with Phase 1, each answering a question the raw tables cannot answer
cheaply:

| View | Answers |
| --- | --- |
| `account_flow_daily` | Net value in and out, per account, per asset, per day |
| `asset_velocity` | How much an asset actually moves, and among how many accounts |
| `anchor_payment_volume` | Payment volume grouped by anchor issuer |
| `trade_pair_activity` | Trade count and volume per asset pair |
| `top_accounts_by_volume` | Accounts ranked by total payment volume |

The anchor issuer list is configuration, not hardcoded values.

## Roadmap

- **Phase 1** — core schema, ingestion of payments, trustlines and trades from a real
  testnet ledger range into SQLite, the five analytical views, CLI, CI.
- **Phase 2** — Postgres support behind the same schema, migration tooling and a
  verified migration path, materialized views for the expensive aggregations, and
  incremental ingestion rather than full re-ingest.
- **Phase 3 (stretch)** — read-only query API over the views, Soroban contract event
  ingestion, streaming ingestion.

Phase 1 is verified against real testnet ledger data. Synthetic fixtures do not stand
in for the ingestion pipeline.

## Documentation

- [PRD.md](PRD.md) — problem, goals, non-goals, success criteria
- [ARCHITECTURE.md](ARCHITECTURE.md) — schema, ingestion design, the SQLite to
  Postgres migration path
- [BACKLOG.md](BACKLOG.md) — phased work items

## Requirements

Node and a C toolchain for the native SQLite driver. Exact versions and install steps
are documented alongside the CLI.

## License

MIT — see [LICENSE](LICENSE).
