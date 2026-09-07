-- 005_anchor_payment_volume: payment volume and count grouped by anchor issuer.
--
-- Third of the five analytical views from ARCHITECTURE.md.
--
-- Answers: "What is the payment volume through anchor Y over time?"
--
-- Design requirement (Issue #9):
--   The anchor issuer list must be config-driven, not hardcoded into the SQL view.
--   To achieve this, the schema introduces an `anchor_issuers` lookup table that is
--   populated from configuration at runtime. The view joins `payments.asset_issuer`
--   to `anchor_issuers.account_id`, keeping the view SQL free of issuer literals.
--
-- Grain: one row per (issuer_account_id, asset_code, day).
--
-- Implementation notes:
--   1. `anchor_issuers` enforces `account_id <> ''` so native assets (empty string issuer)
--      cannot be inserted as an anchor and accidentally match XLM payments.
--   2. The view explicitly filters `p.asset_issuer <> ''` as defense-in-depth against
--      native payment attribution.
--   3. Amounts: Stored as TEXT and cast at query time via `CAST(p.amount AS REAL)`.
--   4. Day bucketing: Uses `date(created_at)` on UTC ISO8601 strings in SQLite.

CREATE TABLE anchor_issuers (
  account_id    TEXT PRIMARY KEY CHECK (account_id <> ''),
  name          TEXT,
  home_domain   TEXT
);

CREATE VIEW anchor_payment_volume AS
SELECT
  a.account_id AS issuer_account_id,
  a.name AS anchor_name,
  a.home_domain,
  p.asset_code,
  date(o.created_at) AS day,
  COUNT(p.operation_id) AS payment_count,
  SUM(CAST(p.amount AS REAL)) AS total_volume
FROM payments p
JOIN operations o ON p.operation_id = o.id
JOIN anchor_issuers a ON p.asset_issuer = a.account_id
WHERE p.asset_issuer <> ''
GROUP BY a.account_id, a.name, a.home_domain, p.asset_code, date(o.created_at);
