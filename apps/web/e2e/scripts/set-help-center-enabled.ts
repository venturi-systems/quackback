/**
 * Enable the help-center fixture, then restore its exact prior settings.
 *
 * The widget is held disabled, as db:seed leaves it. Every widget route answers
 * 404 while the widget is off (src/lib/server/widget/widget-enabled.ts), and the
 * portal's own search must work in that state (venturi-systems/feedback#472), so
 * the suite runs it there whatever the workspace had configured before.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
/**
 * The snapshot as stored. One written before this script captured the widget
 * has no widget_config key; JSON keeps a null column as null, so only that
 * older shape reads back as undefined.
 */
type StoredSnapshot = Omit<Snapshot, 'widget_config'> & { widget_config?: string | null }

function isColumn(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * Read the snapshot, or null when there is none. A malformed file, whether it
 * is not JSON or not a snapshot, fails here with its path, before any value
 * from it reaches a query: postgres.js rejects an undefined parameter, and a
 * restore that fails leaves the fixture enabled.
 */
function readSnapshot(): StoredSnapshot | null {
  let text: string
  try {
    text = readFileSync(snapshotPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    // An empty or truncated file, such as one left by a run killed between
    // creating the snapshot and writing it, must name the file to remove.
    throw new Error(`Malformed help-center snapshot: ${snapshotPath}`, { cause: error })
  }
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >
  if (
    typeof stored.id !== 'string' ||
    !isColumn(stored.feature_flags) ||
    !isColumn(stored.help_center_config) ||
    (stored.widget_config !== undefined && !isColumn(stored.widget_config))
  ) {
    throw new Error(`Malformed help-center snapshot: ${snapshotPath}`)
  }
  return stored as StoredSnapshot
}

/**
 * Add the widget column to a snapshot written before this script captured it.
 * That older script never changed widget_config, so the row still holds the
 * value it had before the fixture, and the snapshot records it before this
 * run changes the widget. The file is replaced by rename, so an interrupted
 * write cannot destroy the original snapshot.
 */
function upgradeLegacySnapshot(row: Snapshot) {
  const snapshot = readSnapshot()
  if (snapshot === null || snapshot.widget_config !== undefined) return
  if (snapshot.id !== row.id) {
    throw new Error(`Help-center snapshot names another settings row: ${snapshotPath}`)
  }
  const upgraded: Snapshot = { ...snapshot, widget_config: row.widget_config }
  const temporaryPath = `${snapshotPath}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(upgraded), { flag: 'w', mode: 0o600 })
  renameSync(temporaryPath, snapshotPath)
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
        upgradeLegacySnapshot(row)
      }
      const flags = { ...JSON.parse(row.feature_flags ?? '{}'), helpCenter: true }
      const config = { ...JSON.parse(row.help_center_config ?? '{}'), enabled: true }
      const widget = { ...JSON.parse(row.widget_config ?? '{}'), enabled: false }
      await sql`
        UPDATE settings SET feature_flags = ${JSON.stringify(flags)},
          help_center_config = ${JSON.stringify(config)},
          widget_config = ${JSON.stringify(widget)} WHERE id = ${row.id}
      `
    } else {
      const snapshot = readSnapshot()
      if (snapshot === null) return
      if (snapshot.widget_config === undefined) {
        // No enable since the older script wrote this snapshot has changed
        // widget_config: enable upgrades the snapshot before it changes the
        // widget. Restore the two columns it holds and leave the widget as is.
        await sql`
          UPDATE settings SET feature_flags = ${snapshot.feature_flags},
            help_center_config = ${snapshot.help_center_config} WHERE id = ${snapshot.id}
        `
      } else {
        await sql`
          UPDATE settings SET feature_flags = ${snapshot.feature_flags},
            help_center_config = ${snapshot.help_center_config},
            widget_config = ${snapshot.widget_config} WHERE id = ${snapshot.id}
        `
      }
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

// Awaited so the module settles only after the fixture action has finished.
await main().catch((error) => {
  // A wrapped error keeps the underlying reason, such as the JSON parser's, as its cause.
  const reason =
    error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ''
  console.error((error instanceof Error ? error.message : String(error)) + reason)
  process.exitCode = 1
})
