/**
 * Helpers for the board-access-matrix e2e suite.
 *
 * - `loginViaMagicLink` establishes a session for ANY email on a context
 *   (Better-auth's magic-link verify auto-creates the user if new), mirroring
 *   the admin global-setup flow. Lets a single public project drive multiple
 *   real identities (admin / authenticated user / segment member).
 * - `setupAccessFixtures` / `setWorkspaceAnon` / `setPortalAuthMethods` drive
 *   deterministic DB setup via CLI scripts (same pattern as db-helpers.ts).
 * - `flushMagicLinkRateLimit` clears the per-email rate-limit keys in Redis so
 *   repeated e2e runs don't hit the sign-in rate limiter.
 *
 * Every helper here shells out to a script under `../scripts`, and each script
 * that has to invalidate a Redis-cached read does it itself, through the
 * application's own client (`@/lib/server/redis`, pointed at REDIS_URL). None
 * of this reaches for `docker exec` against a named container: the compose
 * stack's `quackback-dragonfly` exists on a developer's machine and nowhere
 * else, and the CI lane runs Redis as a service container with no docker CLI
 * available to the job at all. REDIS_URL is the one address both environments
 * agree on.
 */
import { execFileSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { expect, type BrowserContext } from '@playwright/test'
import { getMagicLinkToken, ensureTestUserHasRole } from './db-helpers'

const __dirname = dirname(fileURLToPath(import.meta.url))

function runScript(scriptRelPath: string, args: string[]): string {
  const scriptPath = resolve(__dirname, scriptRelPath)
  // execFileSync (no shell) so test args can't be interpreted as shell syntax.
  return execFileSync('dotenv', ['-e', '../../.env', '--', 'bun', scriptPath, ...args], {
    encoding: 'utf-8',
    cwd: resolve(__dirname, '../..'), // apps/web
  }).trim()
}

export interface BoardFixture {
  slug: string
  postId: string
}

export interface AccessFixtures {
  segmentId: string
  memberPrincipalId: string
  boards: {
    public: BoardFixture
    allanon: BoardFixture
    segview: BoardFixture
    mixedseg: BoardFixture
    private: BoardFixture
    mod: BoardFixture
  }
}

/**
 * Provision the e2e-* boards + segment and add `memberEmail` to the segment.
 * The member must already exist (sign them in once before calling this).
 */
export function setupAccessFixtures(memberEmail: string): AccessFixtures {
  return JSON.parse(
    runScript('../scripts/setup-access-fixtures.ts', [memberEmail])
  ) as AccessFixtures
}

/** Flip the workspace `features.allowAnonymous` master switch. */
export function setWorkspaceAnon(enabled: boolean): void {
  runScript('../scripts/set-workspace-anon.ts', [String(enabled)])
}

/**
 * Flip sign-in methods and drop the tenant-settings cache (the script does
 * both). `disable` / `restore` patch `settings.portal_config.oauth` — used by
 * tests that need to verify the team break-glass form is still served when the
 * portal offers no public sign-in methods; always call
 * `setPortalAuthMethods('restore')` in a `finally` block so subsequent
 * tests/dev aren't left with a broken portal. `enable-magic-link` patches
 * `settings.auth_config.oauth` instead, because that is the map the
 * request-time gate reads — see {@link enableMagicLinkSignIn}.
 */
export function setPortalAuthMethods(action: 'disable' | 'restore' | 'enable-magic-link'): void {
  runScript('../scripts/set-portal-auth-methods.ts', [action])
}

/**
 * Turn the magic-link sign-in method ON in `settings.auth_config.oauth` — the
 * map `isAuthMethodAllowed` gates on — and drop the tenant-settings cache.
 *
 * The suite authenticates through magic link, but magicLink is opt-in
 * (`isSignInMethodEnabled` requires a literal `true`), `DEFAULT_AUTH_CONFIG`
 * ships it off, and `bun run db:seed` leaves `settings.auth_config` NULL. So
 * the test infrastructure enables it for itself; the shipped default stays off.
 *
 * Idempotent — safe on every setup path and on every retry.
 */
export function enableMagicLinkSignIn(): void {
  setPortalAuthMethods('enable-magic-link')
}

/**
 * Flush the magic-link per-email rate-limit keys from Redis so that repeated
 * e2e runs on the same email addresses don't hit the sign-in limiter. No-op
 * when no keys exist; throws if Redis is unreachable.
 */
export function flushMagicLinkRateLimit(): void {
  runScript('../scripts/flush-signin-rate-limit.ts', [])
}

/** Config for {@link seedIdentityProvider} (mirrors the seed script's input). */
export interface SeedIdpConfig {
  registrationId: string
  label: string
  clientId: string
  discoveryUrl?: string
  enabled?: boolean
  showButton?: boolean
  clientSecret?: string
  domain?: { name: string; verified?: boolean; enforced?: boolean }
}

/**
 * Seed an identity_provider row (+ encrypted credential + optional verified
 * domain). The script busts the tenant-settings + configured-integration-types
 * caches itself, so the running dev server reflects the raw-SQL mutation on its
 * next request. Idempotent on `registrationId`. Pair with
 * {@link removeIdentityProvider} in an `afterAll`/`finally` so the workspace is
 * left clean.
 */
export function seedIdentityProvider(cfg: SeedIdpConfig): void {
  runScript('../scripts/seed-identity-provider.ts', ['seed', JSON.stringify(cfg)])
}

/** Remove a seeded identity provider (cascades its domains, drops its credential). */
export function removeIdentityProvider(registrationId: string): void {
  runScript('../scripts/seed-identity-provider.ts', ['remove', registrationId])
}

/**
 * Set the portal visibility. The script also drops the tenant-settings cache —
 * the portal-access decision is served from it — so the dev server evaluates
 * the new visibility on its next request.
 *
 * Always restore to 'public' in a `finally` block so subsequent tests and dev
 * sessions are not left behind a locked gate.
 */
export function setPortalVisibility(visibility: 'private' | 'authenticated' | 'public'): void {
  runScript('../scripts/set-portal-visibility.ts', [visibility])
}

/**
 * Sign `email` into `context` via the magic-link flow (auto-creates the user if
 * new). After this the context's cookies carry the session. Pass `role:'admin'`
 * to also promote the principal to admin (for team-identity tests).
 */
export async function loginViaMagicLink(
  context: BrowserContext,
  email: string,
  opts: { role?: 'admin' | 'member' | 'user' } = {}
): Promise<void> {
  const send = await context.request.post('/api/auth/sign-in/magic-link', {
    data: { email, callbackURL: '/' },
  })
  expect(send.ok(), `magic-link send for ${email}`).toBeTruthy()

  const token = getMagicLinkToken(email)
  expect(token.length).toBeGreaterThan(8)

  const verify = await context.request.get(
    `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent('/')}`,
    { maxRedirects: 5 }
  )
  expect(verify.ok(), `magic-link verify for ${email}`).toBeTruthy()

  if (opts.role) ensureTestUserHasRole(email, opts.role)
}
