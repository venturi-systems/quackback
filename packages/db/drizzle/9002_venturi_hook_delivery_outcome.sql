-- Venturi fork migration (landing-page#2309). Outcome-aware hook delivery
-- lease, back-ported from upstream QuackbackIO/quackback 01cd9b96b (A1,
-- 0190_audit_invariants.sql, hook_deliveries part only). Existing rows are
-- finished deliveries, so they read as completed.
--
-- Numbering: see 9001_venturi_two_factor_lockout.sql. Additive and idempotent.
ALTER TABLE "hook_deliveries" ADD COLUMN IF NOT EXISTS "outcome" text NOT NULL DEFAULT 'completed';
