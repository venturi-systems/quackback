-- Stable external identity for widget-identified visitors: the verified JWT
-- `sub` (the host app's durable user id). Nullable and set ONLY on the verified
-- ssoToken identify path, so a visitor is recognized on a new device even after
-- an email change. Team accounts and unverified identifies leave it null.
-- Additive — existing rows backfill to NULL with no rewrite.
ALTER TABLE "user" ADD COLUMN "external_id" text;

-- One account per external subject. Partial so the column stays sparse and the
-- many null rows (team accounts, unverified visitors) don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS "user_external_id_idx"
  ON "user" ("external_id") WHERE "external_id" IS NOT NULL;
