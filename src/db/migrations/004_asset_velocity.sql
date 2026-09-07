-- 004_asset_velocity: transfer count and volume per asset per day.
--
-- Second of the five analytical views from ARCHITECTURE.md.
--
-- Answers: "Which assets are actually moving, and how broadly are they circulating?"
--
-- Grain: one row per (asset_code, asset_issuer, day).
--
-- Design decision on windowing (Issue #8):
--   SQL views cannot accept parameters. Rather than hardcoding a relative window
--   against `now()` (which creates non-deterministic output, breaks static testing,
--   and causes refresh-order race conditions in Phase 2 materialized views), this
--   view models a daily grain: one row per (asset, day). Callers sum over their
--   desired date range (e.g. trailing 7, 30, or 90 days) at query time.
--
-- Implementation notes:
--   1. Reads payments joined with operations for created_at timestamp.
--   2. Metrics:
--        - transfer_count: total number of payment operations for the asset on that day.
--        - total_volume: sum of payment amounts for the asset on that day.
--        - distinct_senders: count of distinct from_account addresses.
--        - distinct_receivers: count of distinct to_account addresses.
--   3. Day bucketing: Uses `date(created_at)` on UTC ISO8601 strings in SQLite.
--   4. Amounts: Stored as TEXT and cast at query time via `CAST(amount AS REAL)`.

CREATE VIEW asset_velocity AS
SELECT
  p.asset_code,
  p.asset_issuer,
  date(o.created_at) AS day,
  COUNT(p.operation_id) AS transfer_count,
  SUM(CAST(p.amount AS REAL)) AS total_volume,
  COUNT(DISTINCT p.from_account) AS distinct_senders,
  COUNT(DISTINCT p.to_account) AS distinct_receivers
FROM payments p
JOIN operations o ON p.operation_id = o.id
GROUP BY p.asset_code, p.asset_issuer, date(o.created_at);
