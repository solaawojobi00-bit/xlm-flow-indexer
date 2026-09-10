# xlm-flow-indexer

A lightweight, self-hostable indexer that pulls Stellar ledger data out of Horizon into a relational schema built for analytical SQL.

## The problem

Anyone building on Stellar who wants to answer historical questions — how an account's asset flow has changed over time, what payment volume moved through an anchor this month, which assets see the most path-payment routing, or how DEX trading is distributed between orderbooks and liquidity pools — currently has to stand up their own ingestion pipeline.

Horizon is not built for analytical aggregation. It is an operational API, and complex analytical aggregate queries against it are slow or impossible. `xlm-flow-indexer` ingests ledger data once and makes it queryable with standard SQL views.

It complements Horizon rather than replacing it — there is no attempt at operational parity (no transaction submission or transaction building).

See [PRD.md](PRD.md) for background, design goals, and non-goals.

---

## Prerequisites

- **Node.js**: `v24.0.0` or higher (uses native Node test runner and ESM modules).
- **C/C++ Build Toolchain**: Required for compiling the native SQLite driver (`better-sqlite3`). On Linux/macOS, standard build tools (`gcc`, `g++`, `make`, or `xcode-select`) and Python are needed; on Windows, Visual Studio Build Tools or Windows Build Tools are required.

## Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/solaawojobi00-bit/xlm-flow-indexer.git
cd xlm-flow-indexer
npm install
```

---

## Quickstart & CLI Usage

The CLI (`xlm-flow-indexer` / `src/cli.ts`) manages schema migrations and runs ingestion jobs against Horizon.

### 1. Apply schema migrations

Before ingesting, initialize the database schema and analytical views:

```bash
npm run migrate -- --db ./indexer.db
```

Or using the CLI directly:

```bash
node src/cli.ts migrate --db ./indexer.db
```

### 2. Ingest ledger data

Ingest payments, trustlines, and trades over a target ledger range:

```bash
node src/cli.ts ingest --from 4539850 --to 4539862 --db ./indexer.db --anchors config/anchors.json
```

#### CLI Ingest Options

- `--from <sequence>`: Starting ledger sequence (integer > 0, required).
- `--to <sequence>`: Ending ledger sequence (integer >= from, required).
- `--db <path>`: Path to the SQLite database file (required).
- `--horizon <url>`: Horizon base URL (default: `https://horizon-testnet.stellar.org`).
- `--anchors <path>`: Optional JSON file defining known anchor issuer accounts.
- `--jobs <list>`: Comma-separated list of jobs to run (`payments`, `trustlines`, `trades`). Default: all jobs.
- `--payments`: Ingest payment operations only.
- `--trustlines`: Ingest trustline creations only.
- `--trades`: Ingest orderbook and liquidity pool trades only.

Ingestion is fully idempotent — running ingestion multiple times over the same ledger range safely ignores duplicate records without duplicating database rows.

### 3. Poll for new ledgers (incremental ingestion)

`ingest` needs an explicit range. `poll` instead resumes each job from where it
last stopped, so only ledgers not yet processed are fetched:

```bash
# First run: say where to begin. Required, so a first poll cannot silently
# skip history.
node src/cli.ts poll --db ./indexer.db --start-ledger 4539850 --interval 30

# Later runs resume on their own.
node src/cli.ts poll --db ./indexer.db --interval 30

# A single tick, for cron or a scheduled workflow.
node src/cli.ts poll --db ./indexer.db --once
```

Progress lives in the `ingest_state` table, one row per job:

```sql
SELECT job, last_ledger, updated_at FROM ingest_state ORDER BY job;
```

#### CLI Poll Options

- `--db <path>`: Path to the SQLite database file (required).
- `--interval <seconds>`: Seconds between ticks (default: `30`).
- `--start-ledger <n>`: Where to begin when a job has no watermark yet. Required on a job's first run.
- `--once`: Run a single tick and exit.
- `--max-ticks <n>`: Stop after `n` ticks.
- `--confirmation-lag <n>`: Ledgers to stay behind the chain head (default: `5`).
- `--max-ledgers <n>`: Most ledgers to cover in one pass (default: `200`).
- `--horizon <url>`, `--jobs <list>`: As for `ingest`.

Two defaults are worth understanding:

- **`--confirmation-lag`** exists because Horizon's own ingestion is
  asynchronous: the newest ledger it reports may not have all of its operations
  queryable yet. Since the watermark only ever moves forward, advancing onto a
  partially-indexed ledger would skip records permanently. Staying a few ledgers
  behind removes that risk.
- **`--max-ledgers`** bounds the work per tick, so returning from a long outage
  does not turn one tick into an unbounded catch-up. Successive ticks walk
  forward until the backlog is drained.

Each job keeps its own watermark, so they advance independently — a trustlines
outage does not rewind payments. A watermark is written only *after* its pass
completes, so an interrupted pass is retried in full rather than skipped.

#### Backfilling after a gap

If ledgers were missed — an outage longer than your retention of them, a bug
found later, a range ingested against a stale anchors file — fill the gap with
the ordinary `ingest` command over the explicit range:

```bash
node src/cli.ts ingest --from 4539000 --to 4539100 --db ./indexer.db --anchors config/anchors.json
```

There is deliberately no separate backfill mode, and no command to rewind a
watermark:

- Backfill writes through **the same statements** as `poll`, so there is no
  second ingestion path that could drift from the first.
- It is safe to run against ledgers already covered. Every insert is
  `ON CONFLICT DO NOTHING`, so overlapping a backfill with polled ground writes
  nothing new rather than duplicating rows.
- It leaves `ingest_state` untouched, so the poll loop keeps moving forward from
  the head and does not re-walk the range you just repaired.

To find gaps, compare what is present against what the watermark claims:

```sql
-- Ledgers the payments job claims to have processed, versus what is stored.
SELECT
  (SELECT last_ledger FROM ingest_state WHERE job = 'payments') AS watermark,
  (SELECT MIN(sequence) FROM ledgers)                           AS first_stored,
  (SELECT MAX(sequence) FROM ledgers)                           AS last_stored,
  (SELECT COUNT(*) FROM ledgers)                                AS stored_count;
```

A `stored_count` smaller than `last_stored - first_stored + 1` means at least
one ledger in that span is missing.

---

## Schema Overview

The database uses a normalized raw storage layer designed for portable SQL aggregation:

- **`ledgers`**: Records ledger sequence numbers, UTC close timestamps (`closed_at`), and operation counts.
- **`accounts`**: Master registry of all Stellar account public keys encountered in ledger operations.
- **`operations`**: Horizon operations linked to their parent `ledgers` and `accounts`, storing operation `type` and `created_at` timestamp.
- **`payments`**: Payment operations referencing `operations`, recording sender (`from_account`), recipient (`to_account`), asset details (`asset_code`, `asset_issuer`), and decimal transfer `amount`. Native XLM uses `asset_issuer = ''` (never `NULL`) to ensure deterministic primary keys.
- **`trustlines`**: Tracked trustline establishments keyed by `(account_id, asset_code, asset_issuer)` with the initial `established_at` timestamp.
- **`trades`**: DEX trades referencing `ledgers`, storing base and counter asset codes and issuers, trade amounts, execution timestamp, and `trade_type` (`orderbook` or `liquidity_pool`).
- **`anchor_issuers`**: Lookup table for configured anchor issuer public keys (`account_id`, `name`, `home_domain`), joined by anchor analytical views.

See [ARCHITECTURE.md](ARCHITECTURE.md) for full schema definitions, type representations, and design rationale.

---

## Analytical Views

Five pre-built SQL views provide instant analytical insights without requiring custom ETL scripts.

### 1. `account_flow_daily`
Calculates daily inbound, outbound, and net asset flow per account and asset.

```sql
SELECT account_id, asset_code, day, inbound, outbound, net
FROM account_flow_daily
ORDER BY day DESC, net DESC
LIMIT 5;
```

**Sample Output:**
```text
┌────────────────────────────────────────────────────────────┬────────────┬──────────────┬─────────┬──────────┬──────┐
│ account_id                                                 │ asset_code │ day          │ inbound │ outbound │ net  │
├────────────────────────────────────────────────────────────┼────────────┼──────────────┼─────────┼──────────┼──────┤
│ GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV   │ native     │ 2026-09-06   │ 8.0     │ 6.0      │ 2.0  │
│ GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH   │ native     │ 2026-09-06   │ 6.0     │ 8.0      │ -2.0 │
│ GB7U7ODIHW4QFO7L3KMO6SJJ6Z56PQ7YWCNGCHAEQZ34GDMQCBFC2FVB   │ PYUSD      │ 2026-09-06   │ 0.0000001│ 0.0     │ 1e-7 │
│ GAC35UVYN2ZR6A6PZZAPMGAKWWOCI6O7HGWHYS4HGREUIT6SW5K2UKF3   │ PYUSD      │ 2026-09-06   │ 0.0     │ 0.0000001│ -1e-7│
└────────────────────────────────────────────────────────────┴────────────┴──────────────┴─────────┴──────────┴──────┘
```

### 2. `asset_velocity`
Measures transfer volume, operation counts, and distinct sender/receiver participation per asset and day.

```sql
SELECT asset_code, day, transfer_count, total_volume, distinct_senders, distinct_receivers
FROM asset_velocity
ORDER BY day DESC, total_volume DESC;
```

**Sample Output:**
```text
┌────────────┬──────────────┬────────────────┬──────────────┬──────────────────┬────────────────────┐
│ asset_code │ day          │ transfer_count │ total_volume │ distinct_senders │ distinct_receivers │
├────────────┼──────────────┼────────────────┼──────────────┼──────────────────┼────────────────────┤
│ native     │ 2026-09-06   │ 7              │ 14.0         │ 2                │ 2                  │
│ PYUSD      │ 2026-09-06   │ 1              │ 0.0000001    │ 1                │ 1                  │
└────────────┴──────────────┴────────────────┴──────────────┴──────────────────┴────────────────────┘
```

### 3. `anchor_payment_volume`
Aggregates payment volume and transaction counts for anchor issuers loaded in `anchor_issuers`.

```sql
SELECT issuer_account_id, anchor_name, asset_code, day, payment_count, total_volume
FROM anchor_payment_volume
ORDER BY day DESC, total_volume DESC;
```

**Sample Output:**
```text
┌────────────────────────────────────────────────────────────┬───────────────────┬────────────┬──────────────┬───────────────┬──────────────┐
│ issuer_account_id                                          │ anchor_name       │ asset_code │ day          │ payment_count │ total_volume │
├────────────────────────────────────────────────────────────┼───────────────────┼────────────┼──────────────┼───────────────┼──────────────┤
│ GBT2KJDKUZYZTQPCSR57VZT5NJHI4H7FOB5LT5FPRWSR7I5B4FS3UU7G   │ Paxos (Testnet)   │ PYUSD      │ 2026-09-06   │ 1             │ 0.0000001    │
└────────────────────────────────────────────────────────────┴───────────────────┴────────────┴──────────────┴───────────────┴──────────────┘
```

### 4. `trade_pair_activity`
Reports DEX trade count and volume normalized across asset pairs, distinguishing between orderbook and liquidity pool executions.

```sql
SELECT asset_a_code, asset_b_code, day, trade_count, asset_a_volume, asset_b_volume, orderbook_trades_count, liquidity_pool_trades_count
FROM trade_pair_activity
ORDER BY day DESC, trade_count DESC;
```

**Sample Output:**
```text
┌──────────────┬──────────────┬──────────────┬─────────────┬────────────────┬────────────────┬────────────────────────┬─────────────────────────────┐
│ asset_a_code │ asset_b_code │ day          │ trade_count │ asset_a_volume │ asset_b_volume │ orderbook_trades_count │ liquidity_pool_trades_count │
├──────────────┼──────────────┼──────────────┼─────────────┼────────────────┼────────────────┼────────────────────────┼─────────────────────────────┤
│ USDC         │ native       │ 2026-09-06   │ 4           │ 20.0           │ 185.1851852    │ 4                      │ 0                           │
│ CETES        │ USDC         │ 2026-09-06   │ 3           │ 221.67         │ 15.0           │ 3                      │ 0                           │
│ CETES        │ native       │ 2026-09-06   │ 3           │ 221.67         │ 135.8300105    │ 0                      │ 3                           │
│ SHOAM        │ USDC         │ 2026-09-06   │ 1           │ 5.0            │ 5.0            │ 1                      │ 0                           │
│ SHOAM        │ native       │ 2026-09-06   │ 1           │ 5.0            │ 25.3564611     │ 1                      │ 0                           │
└──────────────┴──────────────┴──────────────┴─────────────┴────────────────┴────────────────┴────────────────────────┴─────────────────────────────┘
```

### 5. `top_accounts_by_volume`
Ranks accounts by outbound sent volume, inbound received volume, and combined throughput.

```sql
SELECT account_id, asset_code, day, sent_count, received_count, payment_count, sent_volume, received_volume, combined_volume
FROM top_accounts_by_volume
ORDER BY day DESC, combined_volume DESC, account_id ASC
LIMIT 5;
```

**Sample Output:**
```text
┌────────────────────────────────────────────────────────────┬────────────┬──────────────┬────────────┬────────────────┬───────────────┬─────────────┬─────────────────┬─────────────────┐
│ account_id                                                 │ asset_code │ day          │ sent_count │ received_count │ payment_count │ sent_volume │ received_volume │ combined_volume │
├────────────────────────────────────────────────────────────┼────────────┼──────────────┼────────────┼────────────────┼───────────────┼─────────────┼─────────────────┼─────────────────┤
│ GB5FCYPSK4ET44OVBXLJHWFW5LNG3ZLPUFSJTJBCGIM43JIU4RGYRLCH   │ native     │ 2026-09-06   │ 4          │ 3              │ 7             │ 8.0         │ 6.0             │ 14.0            │
│ GBTORQK3ZR3RPJF4WTTSH5KVDOAZ4BJI7PD2ECLSBDNHRG4ICNC4JJZV   │ native     │ 2026-09-06   │ 3          │ 4              │ 7             │ 6.0         │ 8.0             │ 14.0            │
│ GAC35UVYN2ZR6A6PZZAPMGAKWWOCI6O7HGWHYS4HGREUIT6SW5K2UKF3   │ PYUSD      │ 2026-09-06   │ 1          │ 0              │ 1             │ 0.0000001   │ 0.0             │ 0.0000001       │
│ GB7U7ODIHW4QFO7L3KMO6SJJ6Z56PQ7YWCNGCHAEQZ34GDMQCBFC2FVB   │ PYUSD      │ 2026-09-06   │ 0          │ 1              │ 1             │ 0.0         │ 0.0000001       │ 0.0000001       │
└────────────────────────────────────────────────────────────┴────────────┴──────────────┴────────────┴────────────────┴───────────────┴─────────────┴─────────────────┴─────────────────┘
```

---

## Pinned Testnet Range & Fixtures

Phase 1 correctness is validated against recorded testnet ledger ranges captured from Horizon `28.0.1` on **2026-09-06**:

| Job | Ledger Range | Highlights |
| --- | --- | --- |
| **Payments** | `4539850 – 4539862` (13 ledgers) | 8 payments spanning native XLM and PYUSD; 4 distinct accounts |
| **Trustlines** | `4540630 – 4540680` (51 ledgers) | 5 `trustline_created` effects (COLIBRI, USDC) and 1 `trustline_updated` filter case |
| **Trades** | `4534150 – 4534300` (151 ledgers) | 12 DEX trades: 9 orderbook and 3 liquidity pool across CETES, USDC, SHOAM, native |

### Testnet Resets and Re-Pinning

> [!WARNING]
> The Stellar testnet is periodically reset by the SDF. When a reset occurs, previous ledger sequences are wiped and Horizon will return 404 for historical ranges.

When testnet resets:
1. Identify dense ledger ranges on the active testnet covering native and issued payments, trustline creations/updates, and orderbook/liquidity pool trades.
2. Re-record fixtures using the capture script:
   ```bash
   node scripts/capture-fixtures.ts --job payments   --from <ledger> --to <ledger>
   node scripts/capture-fixtures.ts --job trustlines --from <ledger> --to <ledger>
   node scripts/capture-fixtures.ts --job trades     --from <ledger> --to <ledger>
   ```
3. Update fixture assertions in the test suite as documented in [`test/fixtures/README.md`](test/fixtures/README.md).

---

## Testing & Quality Assurance

Run the test suite, linter, and format checks:

```bash
# Run all unit and view regression tests
npm test

# Typecheck TypeScript sources
npm run typecheck

# Lint codebase
npm run lint

# Check formatting
npm run format:check
```

---

## Documentation Links

- [PRD.md](PRD.md) — Problem statement, goals, non-goals, and success metrics.
- [ARCHITECTURE.md](ARCHITECTURE.md) — Architectural design, schema DDL, indexing, and Postgres migration roadmap.
- [BACKLOG.md](BACKLOG.md) — Phased work breakdown and implementation roadmap.
- [test/fixtures/README.md](test/fixtures/README.md) — Horizon fixture recording and testnet capture methodology.

---

## Contributing

Issues and pull requests are welcome. See [BACKLOG.md](BACKLOG.md) for the phased roadmap and open work, and [Testing & Quality Assurance](#testing--quality-assurance) for the checks a change is expected to pass before it is submitted.

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE).
