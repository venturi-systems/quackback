/**
 * CLI: flip sign-in methods for e2e runs, then drop the tenant-settings cache
 * so the running dev server sees the change on its next request. Both settings
 * columns are JSON *text*, so we read → patch → write. There is a single
 * workspace settings row.
 *
 * Two actions, two DIFFERENT columns, because the server reads two different
 * things:
 *
 *  - `disable` / `restore` patch `settings.portal_config.oauth` — the portal
 *    surface's own stored toggles.
 *  - `enable-magic-link` patches `settings.auth_config.oauth` — the unified
 *    sign-in-method map that the request-time gate actually reads.
 *    `isAuthMethodAllowed` (src/lib/server/auth/auth-restrictions.ts) resolves
 *    magic link through `getTenantSettings().authConfig.oauth`, never through
 *    portal_config, so writing the flag into portal_config left the gate
 *    untouched and the action silently did nothing.
 *
 * When disabling: all stored oauth keys plus the known core methods (password,
 * magicLink) are set to false — no portal sign-in method is presented to
 * public users. The team break-glass form (TeamLoginForm) still appears for
 * team-bound callbackUrls; that is the invariant this helper enables testing.
 *
 * When restoring: oauth is reset to the default portal config values
 * (mirrors DEFAULT_PORTAL_CONFIG.oauth — password + standard OAuth on,
 * magicLink off).
 *
 * When enabling magic link: `isSignInMethodEnabled` treats magicLink as opt-in
 * (`value === true`) and DEFAULT_AUTH_CONFIG ships it off, so the e2e suite has
 * to turn it on for itself rather than the product turning it on for everyone.
 * Idempotent, and every other stored auth setting is preserved.
 *
 * Usage: bun set-portal-auth-methods.ts <disable|restore|enable-magic-link>
 */
import postgres from 'postgres'
import { DEFAULT_AUTH_CONFIG } from '@/lib/server/domains/settings/settings.types'
import { cacheDel, getRedis, CACHE_KEYS } from '@/lib/server/redis'

const arg = (process.argv[2] || '').toLowerCase()
if (arg !== 'disable' && arg !== 'restore' && arg !== 'enable-magic-link') {
  console.error('Usage: bun set-portal-auth-methods.ts <disable|restore|enable-magic-link>')
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required')
  process.exit(1)
}
const sql = postgres(connectionString)

/** Parse a settings JSON *text* column; {} on null/garbage. */
function parseConfigColumn(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw as string) as Record<string, unknown>
  } catch {
    return {}
  }
}

try {
  const rows = await sql`
    SELECT id, auth_config, portal_config FROM settings ORDER BY created_at ASC LIMIT 1
  `
  if (rows.length === 0) throw new Error('No settings row found')
  const id = rows[0].id

  if (arg === 'enable-magic-link') {
    // A NULL auth_config means the runtime is reading DEFAULT_AUTH_CONFIG
    // (parseJsonConfig falls back to it), so materialize those defaults before
    // patching — otherwise this write would silently drop the default-on
    // methods instead of adding one.
    const authConfig: Record<string, unknown> = rows[0].auth_config
      ? parseConfigColumn(rows[0].auth_config)
      : { ...DEFAULT_AUTH_CONFIG, oauth: { ...DEFAULT_AUTH_CONFIG.oauth } }
    const existing = (authConfig.oauth as Record<string, unknown>) ?? {}
    authConfig.oauth = { ...existing, magicLink: true }
    await sql`UPDATE settings SET auth_config = ${JSON.stringify(authConfig)} WHERE id = ${id}`
  } else {
    const config = parseConfigColumn(rows[0].portal_config)

    if (arg === 'disable') {
      // Turn off every portal oauth method currently stored plus the core keys.
      // Iterating existing keys handles any dynamic OAuth providers (custom-oidc, etc.)
      // that may have been configured without this script knowing about them.
      const existing = (config.oauth as Record<string, unknown>) ?? {}
      const disabled: Record<string, unknown> = {}
      for (const key of Object.keys(existing)) {
        disabled[key] = false
      }
      // Ensure the canonical methods are explicitly disabled even if not yet stored.
      disabled.password = false
      disabled.magicLink = false
      config.oauth = disabled
    } else {
      // Restore to the default portal oauth config (mirrors DEFAULT_PORTAL_CONFIG.oauth).
      config.oauth = { password: true, email: false, google: true, github: true }
    }

    await sql`UPDATE settings SET portal_config = ${JSON.stringify(config)} WHERE id = ${id}`
  }

  // getTenantSettings caches the whole settings row under CACHE_KEYS.TENANT_SETTINGS
  // for an hour and only the app's own write paths invalidate it, so a raw-SQL
  // patch stays invisible to the running server until the key is dropped. Same
  // primitive invalidateSettingsCache() uses.
  await cacheDel(CACHE_KEYS.TENANT_SETTINGS)

  // Echo only the action. The resulting oauth flags are deterministic per
  // action, callers ignore this output, and logging the oauth object trips
  // clear-text-logging analysis on the `oauth` property name even though
  // these are just boolean enable flags, not secrets.
  console.log(JSON.stringify({ action: arg }))
  await sql.end()
  await getRedis().quit()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  await sql.end()
  process.exit(1)
}
