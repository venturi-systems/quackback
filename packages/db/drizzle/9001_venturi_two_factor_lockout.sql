-- Venturi fork migration (landing-page#2309). Better Auth 1.6.30 twoFactor
-- account-lockout columns: the plugin writes failed_verification_count and
-- locked_until on every TOTP verify (success and failure). Without matching
-- columns the adapter emits `update "two_factor" set  where ...` and 2FA
-- enrolment and sign-in fail with 500. Same SQL as upstream
-- QuackbackIO/quackback 0278_two_factor_lockout.sql (bcd4e6b76, #536), so a
-- later upstream intake is a no-op here.
--
-- Numbering: the 9000 range is reserved for Venturi fork migrations, clear of
-- every upstream number. Its journal `when` sits between 0117 and upstream's
-- 0118, so drizzle still applies upstream 0118+ after a future intake.
-- Additive and idempotent.
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "failed_verification_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "locked_until" timestamptz;
