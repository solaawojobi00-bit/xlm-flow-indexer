-- 007_top_accounts_by_volume: ranked accounts by payment volume.
--
-- Fifth of the five analytical views from ARCHITECTURE.md.
--
-- Answers: "Which accounts are driving the highest payment volume?"
--
-- Grain: one row per (account_id, asset_code, asset_issuer, day).
--
-- Design decisions (Issue #11):
--   1. Volume definitions:
--      An account participates in payments as both sender and recipient.
--      To allow flexible downstream ranking without duplicate views or double-counting,
--      this view exposes:
--        - sent_volume & sent_count: outgoing transfer value and operations
--        - received_volume & received_count: incoming transfer value and operations
--        - combined_volume: total throughput (sent_volume + received_volume)
--        - payment_count: total operations (sent_count + received_count)
--   2. Windowing:
--      Follows Issue #8 design. Exposes a daily grain so callers can filter arbitrary
--      rolling windows (e.g. 7-day, 30-day, 90-day) and sum/rank without wall-clock
--      dependencies on `now()`.
--   3. Deterministic tiebreakers:
--      Queries ranking by volume should order by `combined_volume DESC, account_id ASC`
--      to prevent non-deterministic orderings when volumes are equal.
--   4. Day bucketing: Uses `date(created_at)` on UTC ISO8601 strings in SQLite.
--   5. Amounts: Stored as TEXT and cast at query time via `CAST(... AS REAL)`.

CREATE VIEW top_accounts_by_volume AS
WITH account_payment_legs AS (
  -- Sent legs (from_account)
  SELECT
    p.from_account AS account_id,
    p.asset_code,
    p.asset_issuer,
    date(o.created_at) AS day,
    1 AS sent_count,
    0 AS received_count,
    CAST(p.amount AS REAL) AS sent_volume,
    0.0 AS received_volume
  FROM payments p
  JOIN operations o ON p.operation_id = o.id

  UNION ALL

  -- Received legs (to_account)
  SELECT
    p.to_account AS account_id,
    p.asset_code,
    p.asset_issuer,
    date(o.created_at) AS day,
    0 AS sent_count,
    1 AS received_count,
    0.0 AS sent_volume,
    CAST(p.amount AS REAL) AS received_volume
  FROM payments p
  JOIN operations o ON p.operation_id = o.id
)
SELECT
  account_id,
  asset_code,
  asset_issuer,
  day,
  SUM(sent_count) AS sent_count,
  SUM(received_count) AS received_count,
  SUM(sent_count) + SUM(received_count) AS payment_count,
  SUM(sent_volume) AS sent_volume,
  SUM(received_volume) AS received_volume,
  SUM(sent_volume) + SUM(received_volume) AS combined_volume
FROM account_payment_legs
GROUP BY account_id, asset_code, asset_issuer, day;
