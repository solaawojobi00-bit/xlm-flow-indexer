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

## Current fixture

`testnet-4539850-4539862/horizon.json`

| | |
| --- | --- |
| Network | `Test SDF Network ; September 2015` |
| Horizon | `28.0.1` at `https://horizon-testnet.stellar.org` |
| Ledger range | 4539850 – 4539862 (13 ledgers) |
| Captured | 2026-09-06 |
| Operations in range | 140 |
| Payment-type operations | 8 — 7 native, 1 PYUSD |
| Distinct accounts | 4 |

The range was chosen for density rather than recency: it is the smallest window found
that carries both native and issued-asset payments, so the `asset_issuer` encoding from
issue #1 is exercised against real data instead of only synthetic rows.

## Re-capturing after a testnet reset

When testnet resets, this range stops existing and the ingestion tests will fail
against a fresh capture attempt. Pick a new range and re-record:

```
node scripts/capture-fixtures.ts --from <ledger> --to <ledger>
```

The capture is driven by the real ingestion code, so the fixture always contains
exactly the requests the code makes — a hand-written capture would drift the moment
paging changed.

Then update: the table above, `FIXTURE_NAME` in `test/ingest/payments.test.ts`, and the
expected counts and issuer in that suite. Those expectations are deliberately hard
coded to the recorded data; deriving them from the fixture would make the tests
tautological.

## What is not covered

No path payments appear in the current range — testnet activity is dominated by
Soroban `invoke_host_function` calls. The ingestion handles all three payment types and
the type filter is unit tested, but the path payment branch has no real-data assertion
yet. Worth folding into the next re-capture if a range containing one can be found.
