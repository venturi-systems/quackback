-- Venturi fork migration (landing-page#2309, DEF-15). Bound every active API
-- key created before each key had to carry scopes and an expiry. Such a key
-- has no API scope (the app used to give it full access) or no expiry (it
-- worked forever), and rotation renews only its secret.
--
-- For each active key not bounded before:
--  - no API scope: it keeps any internal capability scope and gets the
--    read-only scopes read:feedback and read:article (LEGACY_API_KEY_SCOPES in
--    apps/web/src/lib/shared/api-key-scopes.ts). A read-only integration keeps
--    working; a key that wrote must be replaced by a new scoped key.
--  - no expiry: it expires 90 days after this migration runs
--    (LEGACY_API_KEY_NOTICE_DAYS, the default lifetime of a new key). That is
--    the administrator's notice to replace it.
--  - an expiry more than a year and a day away: it expires a year after this
--    migration, the longest lifetime a new key may have. (A new key may carry
--    one day of clock-skew slack, so a key created just before this runs is
--    never cut.)
--  - legacy_bounded_at records when, and the API keys settings page shows it.
-- A key already scoped, with an expiry no more than a year and a day away, is
-- left alone, and so is a revoked key. docs/team-designation.md (cutover
-- step 4) lists the bounded keys with read-only SQL.
--
-- The stored scopes are text. Only a value shaped like a JSON array of plain
-- scope strings is cast to jsonb, so a corrupt value cannot fail the
-- migration; it counts as no scope, as the app's parser reads it.
--
-- Numbering: see 9001_venturi_two_factor_lockout.sql. Its journal `when` sits
-- one minute after upstream 0125 and before upstream 0126
-- (0126_rbac_roles_permissions, 1783728000000), so a future upstream intake
-- of 0126+ still applies. Idempotent: a second run finds no key to change.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "legacy_bounded_at" timestamptz;
--> statement-breakpoint
WITH "stored" AS (
  SELECT
    "id",
    CASE
      WHEN "scopes" ~ '^\s*\[\s*("[A-Za-z0-9:_.-]*"\s*(,\s*"[A-Za-z0-9:_.-]*"\s*)*)?\]\s*$'
        THEN "scopes"::jsonb
      ELSE '[]'::jsonb
    END AS "parsed"
  FROM "api_keys"
  WHERE "revoked_at" IS NULL AND "legacy_bounded_at" IS NULL
),
"classified" AS (
  SELECT
    "id",
    "parsed",
    NOT ("parsed" ?| ARRAY[
      'read:feedback', 'write:feedback', 'write:changelog', 'read:article',
      'write:article', 'read:chat', 'write:chat', 'admin:workspace'
    ]) AS "unscoped"
  FROM "stored"
)
UPDATE "api_keys" AS "k"
SET
  "scopes" = CASE
    WHEN "c"."unscoped" THEN (
      SELECT jsonb_agg(DISTINCT "kept"."scope" ORDER BY "kept"."scope")::text
      FROM (
        SELECT "element" AS "scope"
        FROM jsonb_array_elements_text("c"."parsed") AS "element"
        WHERE "element" LIKE 'internal:%'
        UNION ALL SELECT 'read:feedback'
        UNION ALL SELECT 'read:article'
      ) AS "kept"
    )
    ELSE "k"."scopes"
  END,
  "expires_at" = CASE
    WHEN "k"."expires_at" IS NULL THEN now() + interval '90 days'
    ELSE LEAST("k"."expires_at", now() + interval '365 days')
  END,
  "legacy_bounded_at" = now()
FROM "classified" AS "c"
WHERE "k"."id" = "c"."id"
  AND (
    "c"."unscoped"
    OR "k"."expires_at" IS NULL
    OR "k"."expires_at" > now() + interval '366 days'
  );
