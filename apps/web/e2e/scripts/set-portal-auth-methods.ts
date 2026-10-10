/**
 * CLI: flip sign-in methods for e2e runs, then drop the tenant-settings cache
 * so the running dev server sees the change on its next request. Both settings
 * columns are JSON *text*, so we read → patch → write. There is a single
 * workspace settings row.
 *
 * ALL ACTIONS OPERATE ON `settings.auth_config`, because that is the one
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
 * temporary enable or `disable` invocation and the `restore` in the test's `finally`.
 * It also names its owner: the process that will restore the change, which
 * utils/access-helpers.ts sets to its Playwright worker's PID. Parallel
 * workers share this one settings row, so the owned snapshot is a lock over
 * the whole snapshot, change and restore lifecycle:
 *
 *  - A temporary action waits while another running process owns the
 *    snapshot, and reads the row only after that, so it can never record
 *    another worker's temporary change as the original value.
 *  - `restore` leaves alone a snapshot that another running process owns, so a
 *    suite's defensive `restore` cannot undo a change another worker is still
 *    testing.
 *  - A snapshot whose owner has exited was left by a crashed worker or run.
 *    The next `restore` repairs it. A temporary action keeps it and takes it
 *    over, so a Playwright retry that re-runs `disable` after a crash keeps
 *    the ORIGINAL pre-change value rather than snapshotting the
 *    already-modified one.
 *
 * Each invocation holds a Postgres advisory lock while it reads and writes the
 * snapshot and the row, so two invocations never interleave those steps.
 * `restore` reads both stored columns back before consuming the snapshot and
 * keeps it on read failure or mismatch. `restore` with no snapshot is a no-op:
 * no temporary change was recorded.
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
 * `enable-magic-link` is permanent fixture setup; `enable-magic-link-temporarily`
 * takes the same snapshot as `disable` and must be paired with `restore`.
 * `enable-social-only-temporarily` enables the two dummy social providers while turning
 * off password and magic-link entry for viewport-fit acceptance. It uses the
 * same verified snapshot restoration; it never changes production defaults.
 *
 * Usage: bun set-portal-auth-methods.ts <disable|restore|enable-magic-link|enable-magic-link-temporarily|enable-social-only-temporarily>
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { DEFAULT_AUTH_CONFIG } from '@/lib/server/domains/settings/settings.types'
import { getRedis, CACHE_KEYS } from '@/lib/server/redis'

/** Where temporary actions park the original columns for `restore` to put back. */
const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../.auth/portal-auth-snapshot.json'
)

interface AuthSnapshot {
  authConfig: string | null
  portalConfig: string | null
  /** PID of the process that will restore the change (absent in older snapshots). */
  owner?: number
}

/**
 * The process that owns a temporary change this invocation makes. The e2e
 * helper passes its Playwright worker's PID, which outlives this script and
 * runs the matching `restore`. A manual run owns its change only while it runs.
 */
const OWNER_PID = Number(process.env.E2E_PORTAL_AUTH_OWNER_PID) || process.pid

/** Advisory-lock name that serializes every invocation's snapshot and row steps. */
const LOCK_NAME = 'e2e:portal-auth-snapshot'

/**
 * How long a temporary action waits for another process to restore its change.
 * It is shorter than E2E_SCRIPT_TIMEOUT_MS (utils/db-helpers.ts), so a change
 * that is never restored fails here with a reason rather than by the helper
 * killing this script.
 */
const OWNER_WAIT_MS = 45_000
const OWNER_POLL_MS = 250

const arg = (process.argv[2] || '').toLowerCase()
if (
  arg !== 'disable' &&
  arg !== 'restore' &&
  arg !== 'enable-magic-link' &&
  arg !== 'enable-magic-link-temporarily' &&
  arg !== 'enable-social-only-temporarily'
) {
  console.error(
    'Usage: bun set-portal-auth-methods.ts <disable|restore|enable-magic-link|enable-magic-link-temporarily|enable-social-only-temporarily>'
  )
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required')
  process.exit(1)
}
const sql = postgres(connectionString)
let cacheOpened = false
let lock: postgres.ReservedSql | undefined

/** Parse a settings JSON *text* column; {} on null/garbage. */
function parseConfigColumn(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw as string) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** The recorded temporary change, or null when there is none. */
function readSnapshot(): AuthSnapshot | null {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8')) as AuthSnapshot
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return null
  }
}

/** Whether `pid` names a running process. */
function isRunning(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** True while a running process other than this invocation's owner owns `snapshot`. */
function ownedElsewhere(
  snapshot: AuthSnapshot | null
): snapshot is AuthSnapshot & { owner: number } {
  return snapshot !== null && snapshot.owner !== OWNER_PID && isRunning(snapshot.owner)
}

try {
  const temporary =
    arg === 'disable' ||
    arg === 'enable-magic-link-temporarily' ||
    arg === 'enable-social-only-temporarily'

  // The advisory lock lives on one reserved connection, so it is released when
  // this process ends even if it never reaches the unlock below. A temporary
  // action waits, without the lock, while another running process owns the
  // recorded change.
  lock = await sql.reserve()
  const deadline = Date.now() + OWNER_WAIT_MS
  let held: AuthSnapshot | null
  for (;;) {
    await lock`SELECT pg_advisory_lock(hashtext(${LOCK_NAME}))`
    held = readSnapshot()
    if (!temporary || !ownedElsewhere(held)) break
    await lock`SELECT pg_advisory_unlock(hashtext(${LOCK_NAME}))`
    if (Date.now() >= deadline) {
      throw new Error(
        `Portal auth holds a temporary change owned by process ${held.owner}, ` +
          `which did not restore it within ${OWNER_WAIT_MS / 1000}s`
      )
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, OWNER_POLL_MS))
  }

  const rows = await sql`
    SELECT id, auth_config, portal_config FROM settings ORDER BY created_at ASC LIMIT 1
  `
  if (rows.length === 0) throw new Error('No settings row found')
  const id = rows[0].id
  let restorationReadback: 'matched' | 'no-snapshot' | 'owned-by-another-process' | undefined

  if (temporary) {
    // Snapshot the LIVE columns before touching them, unless a snapshot already
    // exists. One that exists here is this owner's own or was left by a process
    // that exited, and on a Playwright retry it holds the true pre-change value
    // where this attempt's read would hold the already-modified one, so it is
    // kept. A left-behind snapshot is taken over, so that another worker's
    // `restore` does not treat it as abandoned while this owner's test runs.
    if (!held) {
      const snapshot: AuthSnapshot = {
        authConfig: (rows[0].auth_config as string | null) ?? null,
        portalConfig: (rows[0].portal_config as string | null) ?? null,
        owner: OWNER_PID,
      }
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true })
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 })
    } else if (held.owner !== OWNER_PID) {
      const snapshot: AuthSnapshot = { ...held, owner: OWNER_PID }
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), { flag: 'w', mode: 0o600 })
    }
  }

  if (arg === 'enable-magic-link' || arg === 'enable-magic-link-temporarily') {
    // A NULL auth_config means the runtime is reading DEFAULT_AUTH_CONFIG
    // (parseJsonConfig falls back to it), so materialize those defaults before
    // patching — otherwise this write would silently drop the default-on
    // methods instead of adding one.
    const authConfig: Record<string, unknown> = rows[0].auth_config
      ? parseConfigColumn(rows[0].auth_config)
      : { ...DEFAULT_AUTH_CONFIG, oauth: { ...DEFAULT_AUTH_CONFIG.oauth } }
    const existing = (authConfig.oauth as Record<string, unknown>) ?? {}
    authConfig.oauth = { ...existing, magicLink: true }
    await sql`UPDATE settings
      SET auth_config = ${JSON.stringify(authConfig)},
          auth_config_version = auth_config_version + 1
      WHERE id = ${id}`
  } else if (arg === 'enable-social-only-temporarily') {
    // Exercise the normal two-provider entry without hiding browser controls.
    // The separate guarded helper supplies dummy credentials; admission and
    // every other setting retain their exact snapshot for restoration.
    const authConfig: Record<string, unknown> = rows[0].auth_config
      ? parseConfigColumn(rows[0].auth_config)
      : { ...DEFAULT_AUTH_CONFIG, oauth: { ...DEFAULT_AUTH_CONFIG.oauth } }
    const existing = (authConfig.oauth as Record<string, unknown>) ?? {}
    authConfig.oauth = {
      ...existing,
      google: true,
      github: true,
      password: false,
      magicLink: false,
    }
    await sql`UPDATE settings
      SET auth_config = ${JSON.stringify(authConfig)},
          auth_config_version = auth_config_version + 1
      WHERE id = ${id}`
  } else if (arg === 'disable') {
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
             portal_config = ${JSON.stringify(portalConfig)},
             auth_config_version = auth_config_version + 1
       WHERE id = ${id}
    `
  } else {
    // Restore the exact columns from before the temporary change, including
    // NULL. A change that another running process owns is left for that
    // process's own `restore`: its test may still depend on it.
    const snapshot = held

    if (ownedElsewhere(snapshot)) {
      restorationReadback = 'owned-by-another-process'
    } else if (snapshot) {
      await sql`
        UPDATE settings
           SET auth_config = ${snapshot.authConfig},
               portal_config = ${snapshot.portalConfig},
               auth_config_version = auth_config_version + 1
         WHERE id = ${id}
      `
      // Verify the database stored the exact text/NULL values before discarding
      // the recovery snapshot. A successful UPDATE alone does not prove that.
      const restored = await sql`
        SELECT auth_config, portal_config FROM settings WHERE id = ${id}
      `.catch(() => {
        // Driver errors can contain configuration values; report only the outcome.
        throw new Error('Portal auth restoration readback failed; snapshot retained')
      })
      if (
        restored.length !== 1 ||
        restored[0].auth_config !== snapshot.authConfig ||
        restored[0].portal_config !== snapshot.portalConfig
      ) {
        throw new Error('Portal auth restoration readback mismatch; snapshot retained')
      }
      rmSync(SNAPSHOT_PATH, { force: true })
      restorationReadback = 'matched'
    } else {
      restorationReadback = 'no-snapshot'
    }
    // No snapshot means no temporary change was recorded (or a previous
    // `restore` already consumed it). Restoring defaults here would be the bug
    // described in the header comment, so do nothing.
  }

  // Each write advances the auth instance version in the same SQL statement.
  // Cache invalidation exposes that version so getAuth rebuilds its cached instance.
  // getTenantSettings caches the whole settings row under CACHE_KEYS.TENANT_SETTINGS
  // for an hour and only the app's own write paths invalidate it, so a raw-SQL
  // patch stays invisible to the running server until the key is dropped. Same
  // primitive invalidateSettingsCache() uses.
  // A suppressed DEL failure could keep the app on a stale settings snapshot,
  // even though the database version advanced. Fail this fixture action and
  // retain the no-snapshot restore path as a safe cache-invalidation retry.
  cacheOpened = true
  try {
    await getRedis().del(CACHE_KEYS.TENANT_SETTINGS)
  } catch {
    throw new Error('Portal auth cache invalidation failed; retry the fixture action')
  }

  await lock`SELECT pg_advisory_unlock(hashtext(${LOCK_NAME}))`
  lock.release()

  // Report only the action and restoration outcome, never stored configuration.
  console.log(JSON.stringify({ action: arg, restorationReadback }))
  await sql.end()
  await getRedis().quit()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  // Ending the pool closes the reserved connection, which drops a held lock.
  lock?.release()
  await sql.end()
  if (cacheOpened) await getRedis().quit()
  process.exit(1)
}
