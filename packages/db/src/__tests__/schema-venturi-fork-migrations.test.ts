/**
 * Venturi fork migrations (landing-page#2309).
 *
 * - Better Auth 1.6.30 writes two_factor.failed_verification_count and
 *   locked_until on every TOTP verify; without the columns 2FA enrolment and
 *   sign-in fail with 500 (upstream bcd4e6b76, #536).
 * - hook_deliveries.outcome carries the outcome-aware delivery lease
 *   (upstream 01cd9b96b, A1).
 * - api_keys.legacy_bounded_at records when 9003 bounded a key created
 *   before every key needed scopes and an expiry (DEF-15).
 * - Fork migrations use the reserved 9000 range. 9001 and 9002 sit between
 *   0117 and upstream's 0118; 9003 sits between 0125 and upstream's 0126.
 *   Drizzle applies a migration only when its `when` is later than the last
 *   applied one, so each placement keeps a future upstream intake of the
 *   following numbers from being skipped.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableColumns } from 'drizzle-orm'
import { twoFactor } from '../schema/auth'
import { hookDeliveries } from '../schema/hook-deliveries'
import { apiKeys } from '../schema/api-keys'

const drizzleDir = fileURLToPath(new URL('../../drizzle', import.meta.url))
const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>
}

/** `when` of upstream QuackbackIO/quackback 0118_identity_provider_consolidate_default_role. */
const UPSTREAM_0118_WHEN = 1783036800000

/** `when` of upstream QuackbackIO/quackback 0126_rbac_roles_permissions (not taken yet). */
const UPSTREAM_0126_WHEN = 1783728000000

/** Fork migrations taken before upstream 0118. */
const FORK_BEFORE_0118 = ['9001_venturi_two_factor_lockout', '9002_venturi_hook_delivery_outcome']

/** Fork migrations taken after upstream 0125. */
const FORK_AFTER_0125 = ['9003_venturi_legacy_api_key_bounds']

describe('two_factor lockout columns', () => {
  it('declares the Better Auth 1.6.30 lockout columns', () => {
    const cols = getTableColumns(twoFactor)
    expect(cols.failedVerificationCount.name).toBe('failed_verification_count')
    expect(cols.failedVerificationCount.notNull).toBe(true)
    expect(cols.lockedUntil.name).toBe('locked_until')
    expect(cols.lockedUntil.notNull).toBe(false)
  })
})

describe('hook_deliveries outcome column', () => {
  it('declares the outcome column with completed as the default', () => {
    const cols = getTableColumns(hookDeliveries)
    expect(cols.outcome.name).toBe('outcome')
    expect(cols.outcome.notNull).toBe(true)
    expect(cols.outcome.default).toBe('completed')
  })
})

describe('api_keys legacy_bounded_at column', () => {
  it('declares a nullable timestamp for keys the DEF-15 migration bounded', () => {
    const cols = getTableColumns(apiKeys)
    expect(cols.legacyBoundedAt.name).toBe('legacy_bounded_at')
    expect(cols.legacyBoundedAt.notNull).toBe(false)
  })
})

describe('fork migration journal', () => {
  const fork = journal.entries.filter((e) => /^9\d{3}_venturi_/.test(e.tag))
  const last0117 = journal.entries.find((e) => e.tag.startsWith('0117_'))

  const last0125 = journal.entries.find((e) => e.tag.startsWith('0125_'))

  it('has the fork migrations, each with its SQL file', () => {
    expect(fork.map((e) => e.tag)).toEqual([...FORK_BEFORE_0118, ...FORK_AFTER_0125])
    for (const e of fork) expect(existsSync(join(drizzleDir, `${e.tag}.sql`))).toBe(true)
  })

  it('orders 9001 and 9002 after 0117 and before upstream 0118', () => {
    const whens = fork.filter((e) => FORK_BEFORE_0118.includes(e.tag)).map((e) => e.when)
    expect(whens).toHaveLength(FORK_BEFORE_0118.length)
    expect([...whens].sort((a, b) => a - b)).toEqual(whens)
    for (const when of whens) {
      expect(when).toBeGreaterThan(last0117!.when)
      expect(when).toBeLessThan(UPSTREAM_0118_WHEN)
    }
  })

  it('orders 9003 after 0125 and before upstream 0126', () => {
    const whens = fork.filter((e) => FORK_AFTER_0125.includes(e.tag)).map((e) => e.when)
    expect(whens).toHaveLength(FORK_AFTER_0125.length)
    for (const when of whens) {
      expect(when).toBeGreaterThan(last0125!.when)
      expect(when).toBeLessThan(UPSTREAM_0126_WHEN)
    }
  })

  it('dates every journal entry from 0117 on after the one before it', () => {
    // Drizzle applies a migration only when its `when` is later than the newest
    // applied one. Upstream's own 0051/0052 pair is out of order, long before
    // any fork migration; from 0117 on the order is the fork's to keep.
    const from = journal.entries.findIndex((e) => e.tag.startsWith('0117_'))
    expect(from).toBeGreaterThan(0)
    for (let i = from + 1; i < journal.entries.length; i++) {
      expect(journal.entries[i]!.when, journal.entries[i]!.tag).toBeGreaterThan(
        journal.entries[i - 1]!.when
      )
    }
  })

  it('writes every fork migration so a re-run is a no-op', () => {
    // migration-reapply.test.ts runs them again against a real database; this
    // pins the statement forms without one.
    for (const e of fork) {
      const sql = readFileSync(join(drizzleDir, `${e.tag}.sql`), 'utf8')
      const statements = sql
        .split('--> statement-breakpoint')
        .map((s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      expect(statements.length, e.tag).toBeGreaterThan(0)
      for (const statement of statements) {
        if (/^ALTER TABLE "\w+" ADD COLUMN /i.test(statement)) {
          expect(statement, e.tag).toMatch(/ADD COLUMN IF NOT EXISTS /i)
        } else if (/^WITH .* UPDATE "api_keys" /i.test(statement)) {
          // 9003's backfill: it only reads keys it has not bounded, and marks
          // each key it changes.
          expect(statement, e.tag).toMatch(/"legacy_bounded_at" IS NULL/)
          expect(statement, e.tag).toMatch(/"legacy_bounded_at" = now\(\)/)
        } else {
          throw new Error(`${e.tag}: classify this statement's re-run behavior: ${statement}`)
        }
      }
    }
  })
})

describe('upstream migrations taken after the fork migrations', () => {
  const lastForkIndex = Math.max(
    ...journal.entries.map((e, i) => (FORK_BEFORE_0118.includes(e.tag) ? i : -1))
  )
  const lastForkWhen = journal.entries[lastForkIndex]!.when
  const later = journal.entries.slice(lastForkIndex + 1)

  /** Upstream QuackbackIO/quackback v0.13.0..v0.13.2 (landing-page#2309, OPT-08). */
  const UPSTREAM_V0_13_2 = [
    '0118_identity_provider_consolidate_default_role',
    '0119_changelog_display_date',
    '0120_changelog_notified_at',
    '0121_board_slug_backfill',
    '0122_help_center_slug_backfill',
    '0123_csat_comment_subscription_backfill',
    '0124_conversation_channel_messenger',
    '0125_conversation_channel_drop_default',
  ]

  it('journals upstream 0118..0125 in order, directly after the fork migrations', () => {
    expect(later.slice(0, UPSTREAM_V0_13_2.length).map((e) => e.tag)).toEqual(UPSTREAM_V0_13_2)
    for (const e of later) expect(existsSync(join(drizzleDir, `${e.tag}.sql`))).toBe(true)
  })

  it('dates every later migration after the last fork migration, in increasing order', () => {
    // Drizzle applies a migration only when its `when` is later than the newest
    // applied one, so a database already at 9002 still applies each of these.
    let previous = lastForkWhen
    for (const e of later) {
      expect(e.when).toBeGreaterThan(previous)
      previous = e.when
    }
  })

  it('keeps journal indexes contiguous', () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i))
  })

  it('writes every statement of upstream 0118..0125 so a re-run is a no-op', () => {
    // Venturi fork: 0119 and 0120 gained IF NOT EXISTS, and 0120's backfill
    // skips rows already stamped. migration-reapply.test.ts runs them again
    // against a real database; this pins the statement forms without one.
    for (const tag of UPSTREAM_V0_13_2) {
      const statements = readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8')
        .replace(/--.*$/gm, '')
        .split(/--> statement-breakpoint|;/)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
      expect(statements.length, tag).toBeGreaterThan(0)
      for (const statement of statements) {
        if (/^ALTER TABLE "\w+" ADD COLUMN /i.test(statement)) {
          expect(statement, tag).toMatch(/ADD COLUMN IF NOT EXISTS /i)
        } else if (/^ALTER TABLE "\w+" ALTER COLUMN "\w+" (SET|DROP) DEFAULT\b/i.test(statement)) {
          // Setting or dropping a default is idempotent.
        } else if (/^UPDATE "\w+" SET /i.test(statement)) {
          expect(statement, tag).toMatch(/ WHERE /i)
        } else {
          throw new Error(`${tag}: classify this statement's re-run behavior: ${statement}`)
        }
      }
    }
  })
})
