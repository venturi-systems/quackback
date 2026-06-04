-- Principal-level contact email: a reusable address for an anonymous visitor
-- (captured in live chat) so an offline reply reaches them across conversations,
-- not just the one where they typed it. Agent-only; the principal stays
-- anonymous. Additive + backfill-safe (existing rows get NULL). Partial index
-- only covers rows that have an address.

ALTER TABLE "principal" ADD COLUMN "contact_email" text;

CREATE INDEX IF NOT EXISTS "principal_contact_email_idx"
  ON "principal" ("contact_email")
  WHERE "contact_email" IS NOT NULL;
