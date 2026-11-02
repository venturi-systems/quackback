-- Additive published @better-auth/oauth-provider 1.7 schema.
-- Preserve legacy client metadata and all existing account/token identities.
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "client_discovery_id" text;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "subject_type" text;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "client_credentials_scopes" text[] DEFAULT '{}'::text[];
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "backchannel_logout_uri" text;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "backchannel_logout_session_required" boolean;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "application_type" text;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "jwks" text;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "jwks_uri" text;
--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "dpop_bound_access_tokens" boolean DEFAULT false;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "resources" text[];
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotation_replay_response" text;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotation_replay_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;
--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;
--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "resources" text[];
--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];
--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "revoked" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;
--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN IF NOT EXISTS "resources" text[];
--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_resource" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "access_token_ttl" integer,
  "refresh_token_ttl" integer,
  "signing_algorithm" text,
  "signing_key_id" text,
  "allowed_scopes" text[],
  "custom_claims" jsonb,
  "dpop_bound_access_tokens_required" boolean DEFAULT false,
  "disabled" boolean DEFAULT false,
  "created_at" timestamp with time zone,
  "updated_at" timestamp with time zone,
  "policy_version" integer DEFAULT 1,
  "metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_resource" (
  "id" text PRIMARY KEY,
  "client_id" text NOT NULL REFERENCES "oauth_client"("client_id") ON DELETE CASCADE,
  "resource_id" text NOT NULL REFERENCES "oauth_resource"("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_client_assertion" (
  "id" text PRIMARY KEY,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_authorization_code_idx" ON "oauth_refresh_token" ("authorization_code_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_authorization_code_idx" ON "oauth_access_token" ("authorization_code_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_resource_client_idx" ON "oauth_client_resource" ("client_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_resource_resource_idx" ON "oauth_client_resource" ("resource_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_client_resource_client_resource_unique" ON "oauth_client_resource" ("client_id", "resource_id");
--> statement-breakpoint
-- 1.6 stored public=true for clients registered with token_endpoint_auth_method=none.
-- Preserve explicit authentication choices; never infer public from a missing secret.
UPDATE "oauth_client" SET "token_endpoint_auth_method" = 'none'
WHERE "token_endpoint_auth_method" IS NULL AND "public" = true;
--> statement-breakpoint
-- The old SPA type is a web application, independently of its public authentication.
UPDATE "oauth_client" SET "application_type" = CASE
  WHEN "type" = 'native' THEN 'native'
  WHEN "type" IN ('web', 'user-agent-based') THEN 'web'
END
WHERE "application_type" IS NULL AND "type" IN ('native', 'web', 'user-agent-based');
--> statement-breakpoint
-- JWT 1.7 records the algorithm and curve on newly generated keys.
-- Existing key material stays unchanged; the plugin handles absent metadata.
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "alg" text;
--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN IF NOT EXISTS "crv" text;
