-- 003_account_flow_daily: net daily flow per account and asset.
--
-- First of the five analytical views from ARCHITECTURE.md.
--
-- Answers: "How has account X's asset flow changed over time?"
--
-- Grain: one row per (account_id, asset_code, asset_issuer, day).
--
-- Implementation notes:
--   1. An account appears in payments as both from_account and to_account. The view
--      unions outbound and inbound flows before aggregating by (account, asset, day),
--      ensuring an account with both inbound and outbound transfers on the same day
--      produces exactly one consolidated row.
--   2. Self-payments (from_account = to_account): These produce both an outbound leg
--      and an inbound leg for the same account. Net flow is zero, but inbound and
--      outbound totals both reflect the transfer volume. This is intentional: the
--      operation occurred and moved funds through the account.
--   3. Day bucketing: Uses `date(created_at)` on UTC ISO8601 strings in SQLite.
--      Phase 2 Postgres translation will use `date_trunc('day', created_at)` on
--      TIMESTAMPTZ.
--   4. Amounts: Stored as TEXT and cast at query time via `CAST(amount AS REAL)`.
--      Phase 2 Postgres migration moves underlying storage to NUMERIC.

CREATE VIEW account_flow_daily AS
WITH flow_legs AS (
  -- Outbound payments (from_account sends amount)
  SELECT
    p.from_account AS account_id,
    p.asset_code,
    p.asset_issuer,
    ${day(o.created_at)} AS day,
    0.0 AS inbound,
    ${amount(p.amount)} AS outbound
  FROM payments p
  JOIN operations o ON p.operation_id = o.id

  UNION ALL

  -- Inbound payments (to_account receives amount)
  SELECT
    p.to_account AS account_id,
    p.asset_code,
    p.asset_issuer,
    ${day(o.created_at)} AS day,
    ${amount(p.amount)} AS inbound,
    0.0 AS outbound
  FROM payments p
  JOIN operations o ON p.operation_id = o.id
)
SELECT
  account_id,
  asset_code,
  asset_issuer,
  day,
  SUM(inbound) AS inbound,
  SUM(outbound) AS outbound,
  SUM(inbound) - SUM(outbound) AS net
FROM flow_legs
GROUP BY account_id, asset_code, asset_issuer, day;
