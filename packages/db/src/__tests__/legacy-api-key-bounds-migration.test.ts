import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '../client'

/**
 * Venturi fork (landing-page#2309, DEF-15): migration
 * 9003_venturi_legacy_api_key_bounds bounds every active API key created before
 * each key had to carry scopes and an expiry.
 *
 * The test copies api_keys into a scratch schema (`LIKE ... INCLUDING ALL`),
 * seeds keys in the shapes the migration meets, runs 9003 exactly as drizzle's
 * migrator splits it, and checks each key. A second run must change nothing.
 * Everything runs in one transaction that is rolled back, and `now()` is the
 * transaction's start time, so expiries compare exactly.
 */

const drizzleDir = join(__dirname, '../../drizzle')
const TAG = '9003_venturi_legacy_api_key_bounds'

/** Statement chunks exactly as drizzle's migrator splits them. */
function chunks(): string[] {
  return readFileSync(join(drizzleDir, `${TAG}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .filter((chunk) => chunk.trim())
}

const SCHEMA = `venturi_legacy_api_key_bounds_${process.pid}`
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

interface KeyState {
  name: string
  scopes: string | null
  expires_in: string | null
  bounded: boolean
  bounded_now: boolean
}

/** Each key's scopes (as jsonb), expiry relative to now() and bound mark. */
async function keyStates(tx: Tx): Promise<Record<string, KeyState>> {
  const rows = await tx.execute<KeyState>(sql`
    SELECT
      name,
      scopes,
      CASE WHEN expires_at IS NULL THEN NULL ELSE (expires_at - now())::text END AS expires_in,
      legacy_bounded_at IS NOT NULL AS bounded,
      coalesce(legacy_bounded_at = now(), false) AS bounded_now
    FROM "api_keys"
  `)
  const byName: Record<string, KeyState> = {}
  for (const row of rows as unknown as KeyState[]) byName[row.name] = row
  return byName
}

async function scopesJson(tx: Tx, name: string): Promise<unknown> {
  const rows = await tx.execute<{ scopes: unknown }>(
    sql`SELECT scopes::jsonb AS scopes FROM "api_keys" WHERE name = ${name}`
  )
  return (rows as unknown as { scopes: unknown }[])[0]!.scopes
}

async function snapshot(tx: Tx): Promise<unknown> {
  const result = await tx.execute(
    sql.raw(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows ` +
        `FROM "${SCHEMA}"."api_keys" t`
    )
  )
  return (result as unknown as { rows: unknown }[])[0]!.rows
}

describe.skipIf(!dbAvailable)('9003 bounds API keys made before scopes and expiry', () => {
  it('narrows unscoped keys to reading, bounds every expiry, and marks each key', async () => {
    if (!db) return
    await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE SCHEMA "${SCHEMA}"`))
        await tx.execute(
          sql.raw(`CREATE TABLE "${SCHEMA}"."api_keys" (LIKE public."api_keys" INCLUDING ALL)`)
        )
        await tx.execute(sql.raw(`SET LOCAL search_path TO "${SCHEMA}", public`))
        // Expiries are compared as intervals from now(); a zone with a daylight
        // saving change inside 90 days would shift them by an hour.
        await tx.execute(sql.raw(`SET LOCAL TimeZone TO 'UTC'`))

        // name, scopes, expires_at, revoked_at: the shapes the migration meets.
        await tx.execute(sql`
          INSERT INTO "api_keys"
            (id, name, key_hash, key_prefix, principal_id, expires_at, revoked_at, scopes)
          SELECT gen_random_uuid(), v.name, md5(v.name) || md5(v.name),
                 left('qb_' || md5(v.name), 12), gen_random_uuid(), v.expires_at,
                 v.revoked_at, v.scopes
          FROM (VALUES
            ('unscoped', NULL::timestamptz, NULL::timestamptz, NULL::text),
            ('internal-only', now() + interval '30 days', NULL, '["internal:tier-limits"]'),
            ('internal-and-junk', NULL, NULL,
             '["bogus", "internal:tier-limits", "internal:tier-limits"]'),
            ('corrupt', now() + interval '10 days', NULL, '{not json'),
            ('quoted-junk', NULL, NULL, '["a\\"b"]'),
            ('empty-array', NULL, NULL, '[]'),
            ('scoped-no-expiry', NULL, NULL, '["write:feedback"]'),
            ('far-expiry', now() + interval '3650 days', NULL, '["read:feedback"]'),
            ('expired-unscoped', now() - interval '1 day', NULL, NULL),
            ('modern', now() + interval '90 days', NULL, '["read:feedback","write:feedback"]'),
            ('modern-skew', now() + interval '365 days' + interval '23 hours', NULL,
             '["admin:workspace"]'),
            ('modern-spaced', now() + interval '30 days', NULL, '[ "read:chat" ]'),
            ('revoked-unscoped', NULL, now() - interval '1 day', NULL)
          ) AS v(name, expires_at, revoked_at, scopes)
        `)

        const before = await snapshot(tx)
        for (const chunk of chunks()) await tx.execute(sql.raw(chunk))
        const keys = await keyStates(tx)

        const readOnly = ['read:article', 'read:feedback']
        const withInternal = ['internal:tier-limits', ...readOnly]

        // No API scope: read only, internal capability scopes kept once.
        for (const name of ['unscoped', 'corrupt', 'quoted-junk', 'empty-array']) {
          expect(await scopesJson(tx, name), name).toEqual(readOnly)
        }
        expect(await scopesJson(tx, 'internal-only')).toEqual(withInternal)
        expect(await scopesJson(tx, 'internal-and-junk')).toEqual(withInternal)
        expect(await scopesJson(tx, 'expired-unscoped')).toEqual(readOnly)

        // No expiry: 90 days from now. A stored expiry inside the year stays.
        for (const name of ['unscoped', 'internal-and-junk', 'quoted-junk', 'empty-array']) {
          expect(keys[name]!.expires_in, name).toBe('90 days')
        }
        expect(keys['scoped-no-expiry']!.expires_in).toBe('90 days')
        expect(keys['internal-only']!.expires_in).toBe('30 days')
        expect(keys['corrupt']!.expires_in).toBe('10 days')
        expect(keys['expired-unscoped']!.expires_in).toBe('-1 days')
        // More than a year and a day away: a year from now.
        expect(keys['far-expiry']!.expires_in).toBe('365 days')

        // A key with an API scope keeps it.
        expect(await scopesJson(tx, 'scoped-no-expiry')).toEqual(['write:feedback'])
        expect(await scopesJson(tx, 'far-expiry')).toEqual(['read:feedback'])

        // Every key it changed is marked with this run's time.
        for (const name of [
          'unscoped',
          'internal-only',
          'internal-and-junk',
          'corrupt',
          'quoted-junk',
          'empty-array',
          'scoped-no-expiry',
          'far-expiry',
          'expired-unscoped',
        ]) {
          expect(keys[name]!.bounded_now, name).toBe(true)
        }

        // Scoped keys with an expiry inside a year and a day, and revoked keys,
        // are left exactly as they were.
        for (const name of ['modern', 'modern-skew', 'modern-spaced', 'revoked-unscoped']) {
          expect(keys[name]!.bounded, name).toBe(false)
        }
        expect(keys['modern']!.scopes).toBe('["read:feedback","write:feedback"]')
        expect(keys['modern-spaced']!.scopes).toBe('[ "read:chat" ]')
        expect(keys['modern-skew']!.expires_in).toBe('365 days 23:00:00')
        expect(keys['revoked-unscoped']!.scopes).toBeNull()
        expect(keys['revoked-unscoped']!.expires_in).toBeNull()

        // Exactly the nine keys above were changed.
        expect(before).not.toEqual(await snapshot(tx))
        expect(Object.values(keys).filter((k) => k.bounded)).toHaveLength(9)

        // A second run changes nothing.
        const afterFirst = await snapshot(tx)
        for (const chunk of chunks()) await tx.execute(sql.raw(chunk))
        expect(await snapshot(tx)).toEqual(afterFirst)

        throw new Error(ROLLBACK) // abort the transaction: nothing here persists
      })
      .catch((e) => {
        if (!(e instanceof Error) || e.message !== ROLLBACK) throw e
      })
  })
})
