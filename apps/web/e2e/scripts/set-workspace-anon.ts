/**
 * CLI: set the workspace `features.allowAnonymous` master switch on/off and
 * print the resulting value. settings.portal_config is a JSON *text* column,
 * so we read → patch → write. There is a single workspace settings row.
 *
 * Usage: bun set-workspace-anon.ts <true|false>
 */
import postgres from 'postgres'
import { CACHE_KEYS, getRedis } from '@/lib/server/redis'

const arg = (process.argv[2] || '').toLowerCase()
if (arg !== 'true' && arg !== 'false') {
  console.error('Usage: bun set-workspace-anon.ts <true|false>')
  process.exit(1)
}
const enabled = arg === 'true'
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
  const features = (config.features as Record<string, unknown>) ?? {}
  features.allowAnonymous = enabled
  config.features = features
  await sql`UPDATE settings SET portal_config = ${JSON.stringify(config)} WHERE id = ${id}`
  // The anonymous sign-in gate reads the same cached settings as auth. A raw
  // fixture write must invalidate that cache before the browser acts again.
  await getRedis().del(CACHE_KEYS.TENANT_SETTINGS)
  console.log(JSON.stringify({ allowAnonymous: enabled }))
  await sql.end()
  await getRedis().quit()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  await sql.end()
  process.exit(1)
}
