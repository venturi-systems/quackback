/**
 * Venturi fork migrations (landing-page#2309).
 *
 * - Better Auth 1.6.30 writes two_factor.failed_verification_count and
 *   locked_until on every TOTP verify; without the columns 2FA enrolment and
 *   sign-in fail with 500 (upstream bcd4e6b76, #536).
 * - hook_deliveries.outcome carries the outcome-aware delivery lease
 *   (upstream 01cd9b96b, A1).
 * - Fork migrations use the reserved 9000 range, and their journal `when`
 *   sits between 0117 and upstream's 0118. Drizzle applies a migration only
 *   when its `when` is later than the last applied one, so this keeps a future
 *   upstream intake of 0118+ from being skipped.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableColumns } from 'drizzle-orm'
import { twoFactor } from '../schema/auth'
import { hookDeliveries } from '../schema/hook-deliveries'

const drizzleDir = fileURLToPath(new URL('../../drizzle', import.meta.url))
const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>
}

/** `when` of upstream QuackbackIO/quackback 0118_identity_provider_consolidate_default_role. */
const UPSTREAM_0118_WHEN = 1783036800000

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

describe('fork migration journal', () => {
  const fork = journal.entries.filter((e) => /^9\d{3}_venturi_/.test(e.tag))
  const last0117 = journal.entries.find((e) => e.tag.startsWith('0117_'))

  it('has the fork migrations, each with its SQL file', () => {
    expect(fork.map((e) => e.tag)).toEqual([
      '9001_venturi_two_factor_lockout',
      '9002_venturi_hook_delivery_outcome',
    ])
    for (const e of fork) expect(existsSync(join(drizzleDir, `${e.tag}.sql`))).toBe(true)
  })

  it('orders fork migrations after 0117 and before upstream 0118', () => {
    const whens = fork.map((e) => e.when)
    expect([...whens].sort((a, b) => a - b)).toEqual(whens)
    for (const when of whens) {
      expect(when).toBeGreaterThan(last0117!.when)
      expect(when).toBeLessThan(UPSTREAM_0118_WHEN)
    }
  })

  it('writes every fork migration idempotently', () => {
    for (const e of fork) {
      const sql = readFileSync(join(drizzleDir, `${e.tag}.sql`), 'utf8')
      const statements = sql
        .split('--> statement-breakpoint')
        .map((s) => s.replace(/--.*$/gm, '').trim())
        .filter(Boolean)
      for (const statement of statements) expect(statement).toMatch(/IF NOT EXISTS/)
    }
  })
})

describe('upstream migrations taken after the fork migrations', () => {
  const lastForkIndex = Math.max(
    ...journal.entries.map((e, i) => (/^9\d{3}_venturi_/.test(e.tag) ? i : -1))
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
})
