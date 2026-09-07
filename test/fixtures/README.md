# Recorded Horizon fixtures

Real responses captured from a live Horizon endpoint and replayed over local HTTP in
the test suite. The bodies are Horizon's own, recorded verbatim — nothing here is
hand-written, edited, or synthesised.

## Why record rather than query testnet directly

ARCHITECTURE.md requires Phase 1 to be verified against a real, fixed testnet ledger
range, and PRD.md forbids substituting invented data for the ingestion pipeline.

Those two requirements collide with a third fact: **Stellar testnet is reset
periodically, and a reset deletes the pinned range.** A CI suite that queries testnet
directly would go red on Stellar's schedule rather than on ours, with nothing in the
diff to explain it.

Recording resolves the collision. The data stays real; only the network hop becomes
local, so the assertions are deterministic and the ingestion code path under test is
the same one that runs against live Horizon.

At the time of capture `history_elder_ledger` was `128` — the current testnet instance
retains history only back to its most recent reset, which is the concern made concrete.

## Current fixtures

Each job gets its own range. Testnet activity is uneven enough that this is not a
convenience: the range with payment traffic contains **zero** trustline effects, and
the range with trustline activity has almost no payments.

Both were captured 2026-09-06 from Horizon `28.0.1` at
`https://horizon-testnet.stellar.org`, network `Test SDF Network ; September 2015`.

### `testnet-payments-4539850-4539862/`

| | |
| --- | --- |
| Ledger range | 4539850 – 4539862 (13 ledgers) |
| Operations in range | 140 |
| Payment-type operations | 8 — 7 native, 1 PYUSD |
| Distinct accounts | 4 |

Chosen for density rather than recency: the smallest window found carrying both native
and issued-asset payments, so the `asset_issuer` encoding from issue #1 is exercised
against real data instead of only synthetic rows.

### `testnet-trustlines-4540630-4540680/`

| | |
| --- | --- |
| Ledger range | 4540630 – 4540680 (51 ledgers) |
| Effects in range | 279 |
| `trustline_created` | 5 — 3 COLIBRI, 2 USDC |
| `trustline_updated` | 1 (asset `TESTGK26`, ledger 4540642) |
| Distinct accounts | 6 |

The single `trustline_updated` is the reason this range was chosen. It is the case that
distinguishes reading `/effects` from reading `change_trust` operations: an update
against an existing line is not an establishment, and a job reading operations would
record it as one. The suite asserts that asset is absent from `trustlines`.

### `testnet-trades-4534150-4534300/`

| | |
| --- | --- |
| Ledger range | 4534150 – 4534300 (151 ledgers) |
| Trades in range | 12 |
| `orderbook` | 9 |
| `liquidity_pool` | **3** |
| Assets | native, USDC, CETES, SHOAM |

Trades are sparse on testnet — a 200-record sample spanned roughly 30,000 ledgers — so
this range was picked from the densest 100-ledger bucket found rather than for
tightness.

It contains both trade mechanisms, which is the point. In a broader sample
**liquidity-pool trades were 95 of 200**, so a job ingesting only order-book trades
would discard about half of DEX activity. The `native`/`CETES` pair in this range occurs
*only* via the pool, so the suite can assert a distinction that would vanish entirely
if `trade_type` were not recorded.

## Re-capturing after a testnet reset

When testnet resets, these ranges stop existing and the ingestion tests will fail
against a fresh capture attempt. Pick new ranges and re-record each job:

```
node scripts/capture-fixtures.ts --job payments   --from <ledger> --to <ledger>
node scripts/capture-fixtures.ts --job trustlines --from <ledger> --to <ledger>
node scripts/capture-fixtures.ts --job trades     --from <ledger> --to <ledger>
```

Replacement ranges need particular contents, or the tests silently stop covering what
they were written for:

- **trustlines**: at least one `trustline_created` and ideally one `trustline_updated`.
- **trades**: both an `orderbook` and a `liquidity_pool` trade.
- **payments**: at least one native and one issued-asset payment.

The capture is driven by the real ingestion code, so the fixture always contains
exactly the requests the code makes — a hand-written capture would drift the moment
paging changed.

Then update: the tables above, the fixture names in `test/ingest/payments.test.ts` and
`test/ingest/trustlines.test.ts`, and the expected counts, issuers and asset codes in
both suites. Those expectations are deliberately hard coded to the recorded data;
deriving them from the fixture would make the tests tautological.

## What is not covered

- **No path payments** appear in the payments range — testnet activity is dominated by
  Soroban `invoke_host_function` calls. The ingestion handles all three payment types
  and the type filter is unit tested, but the path payment branch has no real-data
  assertion yet.
- **No trustline removal and re-establishment** appears in the trustlines range. The
  policy (earliest `established_at` wins) is asserted against direct inserts rather
  than recorded effects, since no such sequence was available to record.
- **No liquidity-pool identifier is stored.** Pool trades are ingested and tagged
  `liquidity_pool`, but Horizon's `base_liquidity_pool_id` / `counter_liquidity_pool_id`
  are not persisted — nothing in Phase 1 or 2 needs pool-level analytics, and the
  columns would be speculative. Worth knowing that this data is **unrecoverable after a
  testnet reset**, so if pool identity is ever wanted, capturing it has to happen before
  then rather than by re-ingesting later.

Worth folding these into a future re-capture if ranges containing them can be found.
