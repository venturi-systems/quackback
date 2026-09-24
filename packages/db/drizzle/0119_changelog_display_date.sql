-- Venturi fork (landing-page#2309): IF NOT EXISTS, so a re-run is a no-op.
ALTER TABLE "changelog_entries" ADD COLUMN IF NOT EXISTS "display_date" timestamp with time zone;
