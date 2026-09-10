-- 008_ingest_state: per-job ingestion progress, for incremental polling.
--
-- Phase 1 re-ingested a full explicit range on every run. Incremental ingestion
-- (issue #52) instead resumes from where each job stopped, which needs that
-- position to survive process restarts.
--
-- Grain: one row per ingestion job. Three jobs exist and they advance
-- independently -- a trustlines failure must not rewind payments -- so the job
-- name is the primary key rather than there being a single global watermark.
--
-- Why the watermark is a ledger sequence and not a paging token:
--
--   1. It is uniform across jobs. Operations and trades page on a bare TOID
--      while effects page on a TOID with an index suffix (`...-1`), so a stored
--      token would mean three shapes and per-job parsing. A ledger sequence is
--      one integer for all three.
--
--   2. It composes with the existing range API. Every job already takes a
--      {fromLedger, toLedger} and derives its own cursor via
--      cursorBeforeLedger, so a delta pass is just another range and the
--      backfill path stays the same code.
--
--   3. Re-reading a ledger is free. The insert statements are all ON CONFLICT
--      DO NOTHING, so the coarser granularity costs a few redundant reads after
--      a crash, never a duplicate row. Issue #6 is what makes that safe.
--
-- The value recorded is the last *fully processed* ledger: it is written only
-- after a pass completes, so an interrupted pass resumes from the start of the
-- range it was working on rather than from the middle of a ledger it had only
-- partly read.

CREATE TABLE ingest_state (
  job           TEXT PRIMARY KEY CHECK (job IN ('payments', 'trustlines', 'trades')),
  last_ledger   INTEGER NOT NULL CHECK (last_ledger >= 0),
  updated_at    ${timestampType} NOT NULL
);
