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
- `--db <path>`: Path to the SQLite database file (required unless `--postgres`).
- `--postgres <url>`: Ingest into Postgres instead, e.g. `postgres://user:pass@host:5432/dbname`. Mutually exclusive with `--db`.
- `--horizon <url>`: Horizon base URL (default: `https://horizon-testnet.stellar.org`).
- `--anchors <path>`: Optional JSON file defining known anchor issuer accounts.
- `--jobs <list>`: Comma-separated list of jobs to run (`payments`, `trustlines`, `trades`). Default: all jobs.
- `--payments`: Ingest payment operations only.
- `--trustlines`: Ingest trustline creations only.
- `--trades`: Ingest orderbook and liquidity pool trades only.

Ingestion is fully idempotent — running ingestion multiple times over the same ledger range safely ignores duplicate records without duplicating database rows.

#### Running against Postgres

Every command takes `--postgres <url>` in place of `--db <path>`, and applies
pending migrations on start with that engine's runner:

```bash
node src/cli.ts migrate --postgres postgres://localhost:5432/xlm
node src/cli.ts ingest --from 4539850 --to 4539862 --postgres postgres://localhost:5432/xlm
node src/cli.ts poll --postgres postgres://localhost:5432/xlm --start-ledger 4539850 --once
```

The jobs themselves are identical on both engines — they write through
`SqlAdapter` rather than to a driver — so the range, the counts and the
idempotency guarantee above do not change with the target. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the seam and the two adapters.

Passing both `--db` and `--postgres` is an error rather than a precedence rule.
Note that the connection string is echoed in the startup banner with its
password masked.

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

- `--db <path>`: Path to the SQLite database file (required unless `--postgres`).
- `--postgres <url>`: Poll into Postgres instead. Mutually exclusive with `--db`.
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

## Web Dashboard (`web/`)

A single read-only status page over a Postgres-backed indexer database: coverage
stat cards and a table of the most active assets. It is a deliberately minimal
slice ([#78](https://github.com/solaawojobi00-bit/xlm-flow-indexer/issues/78)) —
three one-query API routes and one page, no caching layer and no query
abstraction.

**Live:** <https://xlm-flow-indexer.vercel.app>

The deployed instance is backed by a bounded testnet window rather than full
ledger history — see [Backfill window](#backfill-window) below.

It is a **separate npm package** under [`web/`](web/), with its own
`package.json` and lockfile. The root package — the CLI, ingestion jobs,
adapters and migrations — is untouched by it and has no dependency on it.

### Read surface

| Route | Reads | Returns |
| --- | --- | --- |
| `GET /api/coverage` | `ledgers` | Ledger count, min/max sequence, latest close time |
| `GET /api/totals` | `payments`, `trades`, `accounts` | Row counts |
| `GET /api/assets` | `asset_velocity` | Top 20 assets by volume, summed across days |

`/api/assets` sums `transfer_count` and `total_volume` across the view's daily
grain. It deliberately does **not** sum `distinct_senders` / `distinct_receivers`:
those are per-day distinct counts, so adding them across days would count a
recurring account once per day and produce a number that is not a distinct count
of anything. It reports `activeDays` instead, which the daily grain does support.

### Backfill window

The deployed instance holds testnet ledgers **4,679,079 – 4,679,798** — 720
ledgers, covering `2026-09-14T20:49:42Z` to `2026-09-14T21:49:37Z`, an hour of
network activity. This is a deliberate bound, not a full backfill.

The range is contiguous: `720 = max − min + 1`, with no gaps. That matters
because the dashboard describes it as "a contiguous run of 720 ledgers", so a
backfill that skipped ahead would make the page assert something untrue.

Measured ingestion throughput against Horizon testnet is about **50 ledgers per
minute** (a testnet ledger closes every 5 seconds, so an hour of history costs
roughly a quarter-hour to pull). A full history of ~4.68M ledgers would
therefore take on the order of two months of continuous ingestion. The window
was sized to prove the pipeline end to end, not to be complete.

One visible consequence: the **Active days** column reads `1` for every asset.
`asset_velocity` has a daily grain, so the column cannot vary until the ingested
range crosses a UTC midnight — which is a property of *where* the window sits,
not of how large it is. Extending within a single day will not change it, no
matter how many ledgers are added. At roughly 17,280 ledgers per day, a window
that spans a day boundary needs to be positioned to straddle one.

To widen it, run the CLI against the same database. Extend from either end of
the existing range to keep it contiguous:

```bash
# Forward, from the current upper bound.
node src/cli.ts ingest --from 4679799 --to <higher> --postgres "$DATABASE_URL" --anchors config/anchors.json

# Backward, from the current lower bound.
node src/cli.ts ingest --from <lower> --to 4679078 --postgres "$DATABASE_URL" --anchors config/anchors.json
```

Ingestion is idempotent by primary key, so overlapping an already-ingested range
is a no-op rather than a duplicate-row bug.

### Running locally

The dashboard needs a Postgres database that has been migrated and ingested
using the CLI above.

```bash
cd web
npm install

# Point it at your database. This file is gitignored.
echo 'DATABASE_URL=postgres://user:pass@host:5432/dbname' > .env.local

npm run dev
```

### Deploying to Vercel

1. Import the repository as a Vercel project.
2. Set **Root Directory** to `web`. Vercel then detects Next.js on its own.
3. Add the `DATABASE_URL` environment variable in
   **Project Settings → Environment Variables**:

   | Name | Value | Environments |
   | --- | --- | --- |
   | `DATABASE_URL` | Your Postgres connection string, e.g. a Neon pooled URL including `?sslmode=require` | Production, Preview, Development |

`DATABASE_URL` is read only from the environment — it is never committed. No
connection string belongs in the repository, in `vercel.json`, or in any file
under `web/` other than the gitignored `.env.local`.

For a serverless deployment, prefer your provider's **pooled** connection
string. Each instance opens a pool of `max: 1`, but instances scale out
horizontally, so direct connections exhaust the database's connection limit
under load where a pooler does not.

[`web/vercel.json`](web/vercel.json) pins the deployment region to `cle1`
(Cleveland), which is the Vercel region co-located with AWS `us-east-2`. Change
it to match wherever your database actually lives — a cross-region round trip
per query is by far the largest cost on this page.

One note on SSL: `node-postgres` currently treats `sslmode=require` as
`verify-full`, which is *stricter* than libpq's meaning of the same flag. A
future `pg` v9 will adopt libpq semantics and quietly weaken it. If you want
certificate verification pinned regardless of driver version, write
`sslmode=verify-full` explicitly in the connection string.

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
