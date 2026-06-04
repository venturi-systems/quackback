-- Conversation triage metadata: an agent-set priority. Additive/backfill-safe;
-- priority's constant default backfills every existing row to 'none' with no
-- table rewrite (PG 11+).
ALTER TABLE "conversations" ADD COLUMN "priority" text DEFAULT 'none' NOT NULL;
