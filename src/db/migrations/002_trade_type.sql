-- 002_trade_type: distinguish order-book trades from liquidity-pool trades.
--
-- Horizon's /trades returns both mechanisms in one stream, tagged with `trade_type`
-- of either 'orderbook' or 'liquidity_pool'. On testnet, liquidity-pool trades were
-- roughly half of all trades sampled, so excluding them would discard about half of
-- DEX activity -- not acceptable for a project whose PRD names "DEX trade patterns"
-- as a goal.
--
-- Storing both without recording which mechanism produced them is the other wrong
-- answer: trade_pair_activity (issue #10) would sum an order-book fill and an
-- automated-market-maker swap into one figure as though they were the same event.
-- They price differently and mean different things.
--
-- This is a new migration rather than an edit to 001_init.sql because 001 has already
-- been applied and its checksum recorded; the runner refuses to run when an applied
-- migration's content changes, which is exactly the protection working as intended.
--
-- The DEFAULT exists because SQLite requires one when adding a NOT NULL column. No
-- rows predate this migration, so nothing is mislabelled by it.

ALTER TABLE trades
  ADD COLUMN trade_type TEXT NOT NULL DEFAULT 'orderbook'
  CHECK (trade_type IN ('orderbook', 'liquidity_pool'));
