-- Venturi fork (landing-page#2309): IF NOT EXISTS, and the backfill skips rows
-- already stamped, so a re-run is a no-op and keeps each notification time.
ALTER TABLE "changelog_entries" ADD COLUMN IF NOT EXISTS "notified_at" timestamp with time zone;

-- Backfill: mark already-live entries as notified so the reconciler never
-- re-announces the existing backlog. Scheduled (future) entries stay null and
-- get notified when their publish time arrives.
UPDATE "changelog_entries"
SET "notified_at" = "published_at"
WHERE "published_at" IS NOT NULL AND "published_at" <= now() AND "notified_at" IS NULL;
