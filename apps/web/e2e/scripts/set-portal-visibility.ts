/**
 * CLI: set portal visibility in settings.portal_config.
 * settings.portal_config is a JSON *text* column, so we read → patch → write.
 * There is a single workspace settings row.
 *
 * When set to 'private': unauthenticated visitors hit the PortalAccessGate
 * before seeing any portal content. Used by e2e tests that verify the gate
 * renders with the dialog auto-opened (journey 3).
 *
 * Always restore to 'public' in a `finally` block so subsequent tests and
 * dev sessions are not left with a locked portal.
 *
 * The write is raw SQL, so it also drops the tenant-settings cache — the
 * portal-access decision is served from `CACHE_KEYS.TENANT_SETTINGS` for an
 * hour and only the app's own write paths invalidate it, so without this the
 * running server keeps serving the previous visibility. Same primitive
 * `invalidateSettingsCache()` uses, and the same Redis client the app itself
 * connects with (REDIS_URL), so this behaves identically against the
 * docker-compose Dragonfly and against a CI service container.
 *
 * Usage: bun set-portal-visibility.ts <private|authenticated|public>
 */
import postgres from 'postgres'
import { cacheDel, getRedis, CACHE_KEYS } from '@/lib/server/redis'

const arg = (process.argv[2] || '').toLowerCase()
if (arg !== 'private' && arg !== 'authenticated' && arg !== 'public') {
  console.error('Usage: bun set-portal-visibility.ts <private|authenticated|public>')
  process.exit(1)
}

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required')
  process.exit(1)
}
const sql = postgres(connectionString)

try {
  const rows = await sql`SELECT id, portal_config FROM settings ORDER BY created_at ASC LIMIT 1`
  if (rows.length === 0) throw new Error('No settings row found')
  const id = rows[0].id
  let config: Record<string, unknown> = {}
  if (rows[0].portal_config) {
    try {
      config = JSON.parse(rows[0].portal_config as string)
    } catch {
      config = {}
    }
  }

  // Merge the visibility into the access sub-object, preserving other keys.
  const existingAccess = (config.access as Record<string, unknown>) ?? {}
  config.access = { ...existingAccess, visibility: arg }

  await sql`UPDATE settings SET portal_config = ${JSON.stringify(config)} WHERE id = ${id}`
  await cacheDel(CACHE_KEYS.TENANT_SETTINGS)
  console.log(JSON.stringify({ action: 'set-portal-visibility', visibility: arg }))
  await sql.end()
  await getRedis().quit()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  await sql.end()
  process.exit(1)
}
