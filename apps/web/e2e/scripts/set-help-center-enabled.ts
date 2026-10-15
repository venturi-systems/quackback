/**
 * Enable the help-center fixture, then restore its exact prior settings.
 *
 * The widget is enabled as well. The help-center hero search calls
 * /api/widget/kb-search, every widget route answers 404 while the widget is off
 * (src/lib/server/widget/widget-enabled.ts), and db:seed leaves it off.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { CACHE_KEYS, getRedis } from '@/lib/server/redis'

const action = process.argv[2]
if (action !== 'enable' && action !== 'restore') {
  throw new Error('Usage: bun set-help-center-enabled.ts <enable|restore>')
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const sql = postgres(process.env.DATABASE_URL)
const snapshotPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.auth/help-center.json')
type Snapshot = {
  id: string
  feature_flags: string | null
  help_center_config: string | null
  widget_config: string | null
}

async function main() {
  let restored = false
  try {
    if (action === 'enable') {
      const [row] = await sql<Snapshot[]>`
        SELECT id, feature_flags, help_center_config, widget_config FROM settings
        ORDER BY created_at LIMIT 1
      `
      if (!row) throw new Error('No settings row found')
      mkdirSync(dirname(snapshotPath), { recursive: true })
      try {
        // A retry must preserve the original snapshot, not the enabled fixture.
        writeFileSync(snapshotPath, JSON.stringify(row), { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const flags = { ...JSON.parse(row.feature_flags ?? '{}'), helpCenter: true }
      const config = { ...JSON.parse(row.help_center_config ?? '{}'), enabled: true }
      const widget = { ...JSON.parse(row.widget_config ?? '{}'), enabled: true }
      await sql`
        UPDATE settings SET feature_flags = ${JSON.stringify(flags)},
          help_center_config = ${JSON.stringify(config)},
          widget_config = ${JSON.stringify(widget)} WHERE id = ${row.id}
      `
    } else {
      let snapshot: Snapshot
      try {
        snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      await sql`
        UPDATE settings SET feature_flags = ${snapshot.feature_flags},
          help_center_config = ${snapshot.help_center_config},
          widget_config = ${snapshot.widget_config} WHERE id = ${snapshot.id}
      `
      restored = true
    }
    await getRedis().del(CACHE_KEYS.TENANT_SETTINGS)
    if (restored) unlinkSync(snapshotPath)
    console.log(JSON.stringify({ action }))
  } finally {
    await sql.end()
    await getRedis().quit()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
