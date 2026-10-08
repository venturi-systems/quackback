import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compareAndSetAuthConfig,
  runAuthAcceptanceFixture,
  type AuthFixtureDependencies,
} from '../../e2e/scripts/set-auth-acceptance-fixture'

/** A dedicated connection owns a temporary table, leaving the shared test schema untouched. */
describe('auth fixture database version invalidation', () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  const id = randomUUID()
  beforeAll(async () => {
    await sql`CREATE TEMP TABLE settings (
      id uuid PRIMARY KEY,
      auth_config text,
      auth_config_version integer NOT NULL DEFAULT 0
    )`
    await sql`INSERT INTO settings (id) VALUES (${id})`
  })
  afterAll(async () => {
    await sql.end()
  })

  it('advances versions on enable and exact restoration, including null bytes', async () => {
    let snapshot: unknown = null
    let invalidations = 0
    const dependencies: AuthFixtureDependencies = {
      guard() {},
      scope: () => ({ runId: '123', runAttempt: '1' }),
      readSnapshot: () => snapshot,
      writeSnapshot(value) {
        snapshot = structuredClone(value)
      },
      removeSnapshot() {
        snapshot = null
      },
      async connect() {
        return {
          async readSettings() {
            const rows = await sql`SELECT id, auth_config FROM settings`
            return rows.map((row) => ({ id: row.id, authConfig: row.auth_config }))
          },
          compareAndSet: (rowId, expected, next) =>
            compareAndSetAuthConfig(sql, rowId, expected, next),
          async invalidateCache() {
            invalidations++
          },
          async close() {},
        }
      },
    }
    await runAuthAcceptanceFixture('enable', dependencies)
    const [enabled] = await sql`SELECT auth_config, auth_config_version FROM settings`
    expect(enabled.auth_config_version).toBe(1)
    expect(JSON.parse(enabled.auth_config)).toMatchObject({
      oauth: { password: true, magicLink: true },
      openSignup: true,
    })
    await runAuthAcceptanceFixture('enable', dependencies)
    const [retried] = await sql`SELECT auth_config_version FROM settings`
    expect(retried.auth_config_version).toBe(1)
    await runAuthAcceptanceFixture('restore', dependencies)
    const [restored] = await sql`SELECT auth_config, auth_config_version FROM settings`
    expect(restored).toEqual({ auth_config: null, auth_config_version: 2 })
    expect(snapshot).toBeNull()
    expect(invalidations).toBe(3)
  })

  it('never advances the version when a stale compare-and-set loses', async () => {
    await sql`UPDATE settings SET auth_config = 'newer', auth_config_version = 10`
    expect(await compareAndSetAuthConfig(sql, id, null, 'stale')).toBe(false)
    const [row] = await sql`SELECT auth_config, auth_config_version FROM settings`
    expect(row).toEqual({ auth_config: 'newer', auth_config_version: 10 })
  })

  it('allows only one competing update for the same original configuration', async () => {
    await sql`UPDATE settings SET auth_config = 'original', auth_config_version = 20`
    const outcomes = await Promise.all([
      compareAndSetAuthConfig(sql, id, 'original', 'first'),
      compareAndSetAuthConfig(sql, id, 'original', 'second'),
    ])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    const [row] = await sql`SELECT auth_config, auth_config_version FROM settings`
    expect(['first', 'second']).toContain(row.auth_config)
    expect(row.auth_config_version).toBe(21)
  })
})
