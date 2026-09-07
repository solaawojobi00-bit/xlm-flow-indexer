-- 006_trade_pair_activity: trade count and volume per asset pair and day.
--
-- Fourth of the five analytical views from ARCHITECTURE.md.
--
-- Answers: "What is the trading volume, mechanism breakdown, and activity for each market?"
--
-- Grain: one row per (asset_a_code, asset_a_issuer, asset_b_code, asset_b_issuer, day).
--
-- Design decisions (Issue #10):
--   1. Asset Identity (4-column grouping):
--      Groups on all four asset identifier columns (code and issuer for both legs).
--      Stellar assets sharing a ticker from different issuers are distinct markets
--      and must not be merged.
--   2. Market Normalisation (Pair Direction):
--      Horizon reports trades in arbitrary base/counter directions depending on
--      the offer or pool. To treat (XLM, USDC) and (USDC, XLM) as the same unified
--      market rather than splitting volume across two rows, the view normalises the
--      pair lexicographically by `(code || ':' || issuer)`.
--      The lower asset becomes `asset_a` and the higher becomes `asset_b`, with
--      amounts routed to `asset_a_volume` and `asset_b_volume` accordingly.
--   3. Mechanism Breakdown:
--      Reports total trade count as well as separable counts for `orderbook` and
--      `liquidity_pool` trades (added in migration 002).
--   4. Day bucketing: Uses `date(executed_at)` on UTC ISO8601 strings in SQLite.
--   5. Amounts: Stored as TEXT and cast at query time via `CAST(... AS REAL)`.

CREATE VIEW trade_pair_activity AS
WITH normalised_trades AS (
  SELECT
    id,
    trade_type,
    date(executed_at) AS day,
    CASE
      WHEN (base_asset_code || ':' || base_asset_issuer) <= (counter_asset_code || ':' || counter_asset_issuer)
      THEN base_asset_code
      ELSE counter_asset_code
    END AS asset_a_code,
    CASE
      WHEN (base_asset_code || ':' || base_asset_issuer) <= (counter_asset_code || ':' || counter_asset_issuer)
      THEN base_asset_issuer
      ELSE counter_asset_issuer
    END AS asset_a_issuer,
    CASE
      WHEN (base_asset_code || ':' || base_asset_issuer) <= (counter_asset_code || ':' || counter_asset_issuer)
      THEN counter_asset_code
      ELSE base_asset_code
    END AS asset_b_code,
    CASE
      WHEN (base_asset_code || ':' || base_asset_issuer) <= (counter_asset_code || ':' || counter_asset_issuer)
      THEN counter_asset_issuer
      ELSE base_asset_issuer
    END AS asset_b_issuer,
    CASE
      WHEN (base_asset_code || ':' || base_asset_issuer) <= (counter_asset_code || ':' || counter_asset_issuer)
      THEN CAST(base_amount AS REAL)
      ELSE CAST(counter_amount AS REAL)
    END AS asset_a_amount,
    CASE
      WHEN (base_asset_code || ':' || base_asset_issuer) <= (counter_asset_code || ':' || counter_asset_issuer)
      THEN CAST(counter_amount AS REAL)
      ELSE CAST(base_amount AS REAL)
    END AS asset_b_amount
  FROM trades
)
SELECT
  asset_a_code,
  asset_a_issuer,
  asset_b_code,
  asset_b_issuer,
  day,
  COUNT(id) AS trade_count,
  SUM(asset_a_amount) AS asset_a_volume,
  SUM(asset_b_amount) AS asset_b_volume,
  SUM(CASE WHEN trade_type = 'orderbook' THEN 1 ELSE 0 END) AS orderbook_trades_count,
  SUM(CASE WHEN trade_type = 'liquidity_pool' THEN 1 ELSE 0 END) AS liquidity_pool_trades_count
FROM normalised_trades
GROUP BY asset_a_code, asset_a_issuer, asset_b_code, asset_b_issuer, day;
