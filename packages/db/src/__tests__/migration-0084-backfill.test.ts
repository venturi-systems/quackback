import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '../client'

// 0084 collapses the 3 workspace anon toggles into allowAnonymous and
// bumps per-board anonymous tiers where the old workspace flag was off.
// The regression this guards: a tenant whose stored `features` lacks the
// anon keys must still have anonymous comment/submit boards bumped to
// 'authenticated' — because the pre-0084 in-app default for those was OFF.

const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../drizzle/0084_workspace_allow_anonymous_master.sql'),
  'utf8'
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean)

const DB_URL = process.env.DATABASE_URL
let db: Database | null = null
const dbAvailable = !!DB_URL
if (DB_URL) db = createDb(DB_URL, { max: 1 })

afterAll(async () => {
  // createDb pools; close if the client exposes end(). Best-effort.
  // @ts-expect-error optional teardown
  await db?.$client?.end?.()
})

const ACCESS_SUBMIT_ANON = {
  view: 'anonymous',
  vote: 'anonymous',
  comment: 'anonymous',
  submit: 'anonymous',
  segments: { view: [], vote: [], comment: [], submit: [] },
  moderation: { anonPosts: 'inherit', signedPosts: 'inherit', comments: 'inherit' },
}

describe.skipIf(!dbAvailable)('migration 0084 backfill', () => {
  it('bumps anonymous comment/submit to authenticated when features lack the anon keys', async () => {
    if (!db) return
    await db
      .transaction(async (tx) => {
        // Seed a settings row whose features object is MISSING the three anon
        // keys (simulates a tenant persisted before the keys existed). The
        // `voting` key is a real, unrelated flag — present only to prove the
        // backfill keys off absence of the three `anonymous*` keys, not on an
        // empty features object.
        await tx.execute(sql`
          UPDATE "settings"
          SET "portal_config" = jsonb_set(
            COALESCE(NULLIF(portal_config, '')::jsonb, '{}'::jsonb),
            '{features}', '{"voting":true}'::jsonb, true
          )::text
          WHERE portal_config IS NOT NULL
        `)
        // Seed a board whose every action is anonymous. `boards.id` is a
        // uuid column with no DB-level default (the TypeID default is applied
        // at the app layer), so let Postgres mint one and read it back.
        const inserted = await tx.execute<{ id: string }>(sql`
          INSERT INTO "boards" (id, slug, name, access)
          VALUES (gen_random_uuid(), 'm0084-test', 'M0084 Test', ${JSON.stringify(ACCESS_SUBMIT_ANON)}::jsonb)
          RETURNING id
        `)
        const boardId = (inserted as unknown as { id: string }[])[0].id

        // Run the migration statements.
        for (const stmt of MIGRATION_SQL) {
          await tx.execute(sql.raw(stmt))
        }

        // Assert: comment + submit bumped to authenticated; view untouched.
        // postgres-js returns rows directly as an array (not `.rows`).
        const rows = await tx.execute<{ access: typeof ACCESS_SUBMIT_ANON }>(sql`
          SELECT access FROM "boards" WHERE id = ${boardId}
        `)
        const access = (rows as unknown as { access: typeof ACCESS_SUBMIT_ANON }[])[0].access
        expect(access.view).toBe('anonymous') // view has no workspace ceiling
        expect(access.comment).toBe('authenticated')
        expect(access.submit).toBe('authenticated')
        // vote: base default for anonymousVoting is true -> NOT bumped.
        expect(access.vote).toBe('anonymous')

        throw new Error('__ROLLBACK__') // abort the tx so dev data is untouched
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== '__ROLLBACK__') throw e
      })
  })
})
