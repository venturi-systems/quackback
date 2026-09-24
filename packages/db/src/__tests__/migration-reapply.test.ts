import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '../client'

/**
 * Venturi fork (landing-page#2309, OPT-08): fork migrations 9001 and 9002 and
 * upstream 0118..0125 each leave the database unchanged when they run again.
 *
 * CI's database job migrates first, so every table these migrations touch is
 * already at its final shape. The test copies those tables into a scratch
 * schema (`LIKE ... INCLUDING ALL`: columns, defaults, constraints, indexes),
 * puts that schema first on the search path so the migrations' unqualified
 * table names resolve to the copies, seeds rows the backfills would touch,
 * runs the ten migrations again, and compares every column, default and row.
 *
 * Everything runs in one transaction that is rolled back. The real tables are
 * only read (`LIKE` takes ACCESS SHARE), so other suites using the same
 * database are not blocked.
 */

const drizzleDir = join(__dirname, '../../drizzle')

const TAGS = [
  '9001_venturi_two_factor_lockout',
  '9002_venturi_hook_delivery_outcome',
  '0118_identity_provider_consolidate_default_role',
  '0119_changelog_display_date',
  '0120_changelog_notified_at',
  '0121_board_slug_backfill',
  '0122_help_center_slug_backfill',
  '0123_csat_comment_subscription_backfill',
  '0124_conversation_channel_messenger',
  '0125_conversation_channel_drop_default',
]

const TABLES = [
  'two_factor',
  'hook_deliveries',
  'identity_provider',
  'changelog_entries',
  'boards',
  'kb_categories',
  'kb_articles',
  'webhooks',
  'conversations',
]

/** Statement chunks exactly as drizzle's migrator splits them. */
function chunks(tag: string): string[] {
  return readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .filter((chunk) => chunk.trim())
}

const SCHEMA = `venturi_migration_reapply_${process.pid}`
const ROLLBACK = '__ROLLBACK__'

const DB_URL = process.env.DATABASE_URL
let db: Database | null = null
const dbAvailable = !!DB_URL
if (DB_URL) db = createDb(DB_URL, { max: 1 })

afterAll(async () => {
  // @ts-expect-error optional teardown
  await db?.$client?.end?.()
})

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]

async function snapshot(tx: Tx) {
  const columns = await tx.execute(sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = ${SCHEMA}
    ORDER BY table_name, column_name
  `)
  const rows: Record<string, unknown> = {}
  for (const table of TABLES) {
    const result = await tx.execute(
      sql.raw(
        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM "${SCHEMA}"."${table}" t`
      )
    )
    rows[table] = (result as unknown as { rows: unknown }[])[0]!.rows
  }
  return { columns: [...(columns as unknown as Record<string, unknown>[])], rows }
}

describe.skipIf(!dbAvailable)('fork and upstream v0.13.2 migrations run again', () => {
  it('leave every column, default and row as the first run left them', async () => {
    if (!db) return
    await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE SCHEMA "${SCHEMA}"`))
        for (const table of TABLES) {
          await tx.execute(
            sql.raw(`CREATE TABLE "${SCHEMA}"."${table}" (LIKE public."${table}" INCLUDING ALL)`)
          )
        }
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${SCHEMA}", public`))
        const current = await tx.execute<{ schema: string }>(sql`SELECT current_schema() AS schema`)
        expect((current as unknown as { schema: string }[])[0]!.schema).toBe(SCHEMA)

        // Rows a re-run could rewrite: an entry the reconciler announced a day
        // after it went live (0120 must keep that time), a scheduled entry
        // not announced yet, and an SSO provider in its post-0118 shape.
        await tx.execute(sql`
          INSERT INTO "changelog_entries" (id, title, content, published_at, notified_at)
          VALUES
            (gen_random_uuid(), 'Announced', 'c', now() - interval '3 days', now() - interval '2 days'),
            (gen_random_uuid(), 'Scheduled', 'c', now() + interval '3 days', NULL)
        `)
        const mapping = { claimPath: 'groups', rules: [{ whenContains: 'admins', role: 'admin' }] }
        await tx.execute(sql`
          INSERT INTO "identity_provider"
            (id, registration_id, label, client_id, enabled, auto_create_users,
             auto_provision_role, attribute_mapping, show_button)
          VALUES
            (gen_random_uuid(), 'oidc_reapply', 'Reapply', 'cid', true, true,
             'member', ${JSON.stringify(mapping)}::jsonb, false)
        `)

        const before = await snapshot(tx)
        for (const tag of TAGS) {
          for (const chunk of chunks(tag)) await tx.execute(sql.raw(chunk))
        }
        const after = await snapshot(tx)

        expect(after).toEqual(before)
        const channel = after.columns.find(
          (c) => c.table_name === 'conversations' && c.column_name === 'channel'
        )
        expect(channel?.column_default).toBeNull() // 0125's end state survives 0124 running again

        throw new Error(ROLLBACK) // abort the transaction: nothing here persists
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== ROLLBACK) throw e
      })
  })
})
