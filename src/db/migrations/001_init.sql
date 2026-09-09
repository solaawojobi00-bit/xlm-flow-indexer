-- 001_init: Phase 1 core schema.
--
-- Mirrors Horizon's operation/effect model closely enough to ingest directly.
-- Analytical views sit on top of these tables and are added by later migrations.
--
-- Two deliberate deviations from the schema block in ARCHITECTURE.md, both
-- documented there and in issue #1:
--
--   1. asset_issuer is NOT NULL DEFAULT '' rather than NULL-for-native. SQLite
--      does not enforce uniqueness across NULL columns in a non-INTEGER primary
--      key, so (account, 'native', NULL) would insert without limit and the
--      trustlines primary key that backs idempotency would not hold for native
--      assets. Postgres behaves the opposite way (PRIMARY KEY implies NOT NULL),
--      so the NULL form would also break the Phase 2 migration parity check.
--
--   2. trades carries base_asset_issuer / counter_asset_issuer. A Stellar asset
--      is identified by code AND issuer; without the issuers, trade_pair_activity
--      would merge distinct assets that share a ticker, and trades could not be
--      joined to payments on asset identity.
--
-- Amounts are TEXT, stored exactly as Horizon returns them, and cast at query
-- time. This avoids float precision loss on values that are decimal strings with
-- 7 places. Phase 2 translates these columns to NUMERIC.
--
-- Timestamps are ISO8601 TEXT (UTC). Phase 2 translates these to TIMESTAMPTZ.

CREATE TABLE ledgers (
  sequence          INTEGER PRIMARY KEY,
  closed_at         ${timestampType}    NOT NULL,
  operation_count   INTEGER NOT NULL
);

CREATE TABLE accounts (
  account_id        TEXT PRIMARY KEY
);

CREATE TABLE operations (
  id                TEXT PRIMARY KEY,
  ledger_sequence   INTEGER NOT NULL REFERENCES ledgers(sequence),
  type              TEXT    NOT NULL,
  source_account    TEXT    NOT NULL REFERENCES accounts(account_id),
  created_at        ${timestampType}    NOT NULL
);

CREATE TABLE payments (
  operation_id      TEXT PRIMARY KEY REFERENCES operations(id),
  from_account      TEXT NOT NULL REFERENCES accounts(account_id),
  to_account        TEXT NOT NULL REFERENCES accounts(account_id),
  asset_code        TEXT NOT NULL,
  -- '' for native, never NULL. See header note 1.
  asset_issuer      TEXT NOT NULL DEFAULT '',
  amount            ${amountType} NOT NULL
);

CREATE TABLE trustlines (
  account_id        TEXT NOT NULL REFERENCES accounts(account_id),
  asset_code        TEXT NOT NULL,
  -- '' for native, never NULL. This column is part of the primary key, which is
  -- precisely why it cannot be nullable. See header note 1.
  asset_issuer      TEXT NOT NULL DEFAULT '',
  established_at    ${timestampType} NOT NULL,
  PRIMARY KEY (account_id, asset_code, asset_issuer)
);

CREATE TABLE trades (
  id                    TEXT PRIMARY KEY,
  ledger_sequence       INTEGER NOT NULL REFERENCES ledgers(sequence),
  base_asset_code       TEXT NOT NULL,
  -- '' for native, never NULL. See header note 2.
  base_asset_issuer     TEXT NOT NULL DEFAULT '',
  counter_asset_code    TEXT NOT NULL,
  counter_asset_issuer  TEXT NOT NULL DEFAULT '',
  base_amount           ${amountType} NOT NULL,
  counter_amount        ${amountType} NOT NULL,
  executed_at           ${timestampType} NOT NULL
);

-- Phase 1 indexes, per ARCHITECTURE.md. Issue #15 revisits these against the
-- actual query plans of the five analytical views.
CREATE INDEX idx_payments_from_account ON payments(from_account);
CREATE INDEX idx_payments_to_account   ON payments(to_account);
CREATE INDEX idx_payments_asset        ON payments(asset_code, asset_issuer);
CREATE INDEX idx_operations_created_at ON operations(created_at);
CREATE INDEX idx_trades_executed_at    ON trades(executed_at);
