# PRD: xlm-flow-indexer

## Problem

Anyone building on Stellar who wants to answer historical questions — "how has
account X's asset flow changed over the last 90 days," "what's the payment
volume through anchor Y this month," "which assets see the most path-payment
routing" — has to stand up their own Horizon ingestion pipeline. Horizon
itself is not built for this: it's an operational API, not an analytical
store, and complex aggregate queries against it are slow or impossible.

There is no lightweight, self-hostable, open-source indexer that takes raw
Stellar ledger data and makes it queryable with standard SQL for analytical
questions.

## Goals

- Ingest Stellar ledger data (payments, path payments, trustlines, offers,
  trades, and Soroban contract events) into a relational schema designed for
  analytical queries, not just operational lookups.
- Provide a small set of pre-built analytical views answering common
  questions out of the box (account flow over time, asset velocity, anchor
  payment volume, DEX trade patterns).
- Support both a lightweight local/dev mode (SQLite) and a production mode
  (Postgres) from the same schema and ingestion code.
- Expose the data via a read-only query API so it's usable without direct DB
  access.
- Prove correctness against real testnet ledger data — no mocked ingestion,
  no synthetic fixtures standing in for the real pipeline.

## Non-Goals (Phase 1–2)

- Not a block explorer UI. No frontend beyond minimal API documentation.
- Not a real-time streaming system in Phase 1. Polling-based ingestion is
  acceptable; streaming/websocket ingestion is a later-phase stretch goal,
  not a Phase 1 requirement.
- Not a general-purpose ETL framework. Scope is Stellar ledger data
  specifically.
- Not a replacement for Horizon. This complements Horizon for analytical
  workloads; it does not attempt operational parity (submitting
  transactions, building unsigned txs, etc.).

## Target Users

- Stellar/Soroban developers who need historical analytics without running
  their own ingestion pipeline.
- OSS maintainers and tooling builders who want basic on-chain activity
  metrics for their own projects' on-chain components.
- Researchers evaluating ecosystem activity patterns.

## Success Metrics

- Phase 1: ingest a real testnet ledger range end-to-end into SQLite, with
  at least 5 documented analytical queries returning correct results against
  that real data.
- Phase 2: same schema and ingestion logic running against Postgres, with a
  migration path documented and exercised (not just described).
- Commit history that reflects sustained, incremental development across the
  backlog rather than large one-shot drops.

## Phases Overview

- **Phase 1 (testnet-verified):** Core schema, ingestion of payments +
  trustlines + trades from a real testnet ledger range into SQLite, 5+
  working analytical queries, CI green.
- **Phase 2:** Postgres support behind the same schema, migration tooling,
  materialized views for the more expensive aggregations, incremental
  ingestion (cron/poll-based, not full re-ingest).
- **Phase 3 (stretch):** Read-only query API, Soroban contract event
  ingestion, basic rate-limited public access.

## Constraints

- PRD.md and ARCHITECTURE.md committed first, before any implementation.
- Phase 1 must run against real testnet data — no mocked ingestion.
- CLAUDE.md and `.claude/` gitignored from first commit.
- No credentialing or program-status language anywhere in repo files.
- Feature branch workflow, explicit approval gates before commit/push/PR/
  merge, no AI co-author attribution in commits.
