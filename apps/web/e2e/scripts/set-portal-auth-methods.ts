/**
 * CLI: flip sign-in methods for e2e runs, then drop the tenant-settings cache
 * so the running dev server sees the change on its next request. Both settings
 * columns are JSON *text*, so we read → patch → write. There is a single
 * workspace settings row.
 *
 * ALL THREE ACTIONS OPERATE ON `settings.auth_config`, because that is the one
 * map every sign-in surface reads:
 *
 *  - `isAuthMethodAllowed` (src/lib/server/auth/auth-restrictions.ts) resolves
 *    password / magic-link / social through `getTenantSettings().authConfig.oauth`.
 *  - The unified dialog and the private-portal gate render from the same
 *    `authConfig` (portal-auth-form-inline.tsx: `passwordEnabled =
 *    authConfig?.oauth?.password ?? true`), and the break-glass recovery link
 *    appears only when `showOAuth && !emailEntryEnabled` — i.e. only when
 *    password AND magic link are both off IN THAT MAP.
 *
 * `disable` / `restore` used to patch `settings.portal_config.oauth` instead,
 * which nothing on the sign-in path reads (only the one-time
 * backfill/cleanup migrations touch it). Password therefore stayed enabled
 * through a `disable`, `emailEntryEnabled` stayed true, and the SSO-only
 * assertions the action exists to enable could not hold.
 *
 * `restore` is a SNAPSHOT restore, not a reset to defaults. Resetting to
 * DEFAULT_AUTH_CONFIG would be wrong in a specific and quiet way:
 * DEFAULT_AUTH_CONFIG.oauth has no `magicLink` key at all, `parseJsonConfig`
 * deep-merges the stored value OVER the defaults, and `isSignInMethodEnabled`
 * treats a missing magicLink as OFF — so "restoring" would switch magic link
 * off and break every later `loginViaMagicLink` in the run.
 *
 * The snapshot is a file, so it survives the process boundary between one
 * `disable` invocation and the `restore` in the test's `finally`. It is
 * created exclusively (`wx`): a Playwright retry that re-runs `disable` after
 * a crash keeps the ORIGINAL pre-disable value rather than snapshotting the
 * already-disabled one. `restore` consumes and deletes it, so a stale snapshot
 * left by a crashed run is repaired by the next `restore` instead of
 * persisting. `restore` with no snapshot is a no-op: nothing was disabled.
 *
 * When disabling: every stored oauth key plus the core methods (password,
 * magicLink) is set to false — no sign-in method is presented to public users.
 * The team break-glass form still appears for team-bound callbackUrls; that is
 * the invariant this helper enables testing. The defaults are materialized
 * first when the column is NULL, so the write turns methods off rather than
 * leaving the runtime on DEFAULT_AUTH_CONFIG.
 *
 * When enabling magic link: `isSignInMethodEnabled` treats magicLink as opt-in
 * (`value === true`) and DEFAULT_AUTH_CONFIG ships it off, so the e2e suite has
 * to turn it on for itself rather than the product turning it on for everyone.
 * Idempotent, and every other stored auth setting is preserved.
 *
 * Usage: bun set-portal-auth-methods.ts <disable|restore|enable-magic-link>
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { DEFAULT_AUTH_CONFIG } from '@/lib/server/domains/settings/settings.types'
import { cacheDel, getRedis, CACHE_KEYS } from '@/lib/server/redis'

/** Where `disable` parks the pre-disable columns for `restore` to put back. */
const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../.auth/portal-auth-snapshot.json'
)

interface AuthSnapshot {
  authConfig: string | null
  portalConfig: string | null
}

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
  } else if (arg === 'disable') {
    // Snapshot the LIVE columns before touching them. `wx` fails when a
    // snapshot already exists, and that is the point: on a Playwright retry the
    // first attempt's snapshot holds the true pre-disable value, and this
    // attempt's would hold the already-disabled one.
    const snapshot: AuthSnapshot = {
      authConfig: (rows[0].auth_config as string | null) ?? null,
      portalConfig: (rows[0].portal_config as string | null) ?? null,
    }
    try {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), { flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // Keep the earlier, truer snapshot.
    }

    // Turn off every oauth method currently stored plus the core keys, in the
    // map the sign-in gate and the dialog both read. Iterating existing keys
    // handles dynamic OAuth providers (custom-oidc, etc.) configured without
    // this script knowing about them. Materialize the defaults first when the
    // column is NULL, or the runtime keeps reading DEFAULT_AUTH_CONFIG (where
    // password is on) and nothing is actually disabled.
    const authConfig: Record<string, unknown> = rows[0].auth_config
      ? parseConfigColumn(rows[0].auth_config)
      : { ...DEFAULT_AUTH_CONFIG, oauth: { ...DEFAULT_AUTH_CONFIG.oauth } }
    const existing = (authConfig.oauth as Record<string, unknown>) ?? {}
    const disabled: Record<string, unknown> = {}
    for (const key of Object.keys(existing)) {
      disabled[key] = false
    }
    disabled.password = false
    disabled.magicLink = false
    authConfig.oauth = disabled

    // portal_config carries the legacy copy of the same toggles. Nothing on the
    // sign-in path reads it, but the backfill migration merges it into
    // auth_config, so leave the two consistent rather than half-disabled.
    const portalConfig = parseConfigColumn(rows[0].portal_config)
    portalConfig.oauth = { ...disabled }

    await sql`
      UPDATE settings
         SET auth_config = ${JSON.stringify(authConfig)},
             portal_config = ${JSON.stringify(portalConfig)}
       WHERE id = ${id}
    `
  } else {
    // restore: put back exactly what `disable` saw, including a NULL column.
    let snapshot: AuthSnapshot | null = null
    try {
      snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as AuthSnapshot
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    if (snapshot) {
      await sql`
        UPDATE settings
           SET auth_config = ${snapshot.authConfig},
               portal_config = ${snapshot.portalConfig}
         WHERE id = ${id}
      `
      rmSync(SNAPSHOT_PATH, { force: true })
    }
    // No snapshot means nothing was disabled in this run (or a previous
    // `restore` already consumed it). Restoring defaults here would be the bug
    // described in the header comment, so do nothing.
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
