import { getTierLimits } from '@/lib/server/domains/settings/tier-limits.service'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { OSS_TIER_LIMITS } from '@/lib/server/domains/settings/tier-limits.types'

const mocks = vi.hoisted(() => ({ limits: vi.fn() }))
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: mocks.limits,
}))
vi.mock('@/lib/server/db', () => ({
  db: {
    select: () => ({
      from: () => ({ limit: async () => [{ tierLimits: JSON.stringify(await mocks.limits()) }] }),
    }),
  },
  settings: { tierLimits: 'tier_limits' },
}))
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.mocked(getTierLimits).mockResolvedValue({ ...OSS_TIER_LIMITS, apiRequestsPerMinute: 2 })
})
afterEach(() => vi.useRealTimers())

describe('authentication rate reservations', () => {
  it('refunds an accepted reservation exactly once', async () => {
    const { checkRateLimit, reserveAuthenticationAttempt } = await import('../rate-limit')
    const reservation = await reserveAuthenticationAttempt('192.0.2.42')
    expect(reservation.allowed).toBe(true)
    reservation.refund()
    reservation.refund()
    expect((await checkRateLimit('192.0.2.42')).allowed).toBe(true)
    expect((await checkRateLimit('192.0.2.42')).allowed).toBe(true)
    expect((await checkRateLimit('192.0.2.42')).allowed).toBe(false)
  })

  it('cannot refund a newer window', async () => {
    const { checkRateLimit, reserveAuthenticationAttempt } = await import('../rate-limit')
    const stale = await reserveAuthenticationAttempt('192.0.2.43')
    vi.setSystemTime(new Date('2026-01-01T00:01:00.001Z'))
    expect((await checkRateLimit('192.0.2.43')).allowed).toBe(true)
    stale.refund()
    expect((await checkRateLimit('192.0.2.43')).allowed).toBe(true)
    const blocked = await checkRateLimit('192.0.2.43')
    expect(blocked).toMatchObject({ allowed: false, remaining: 0, retryAfter: 60 })
  })

  it('does not refund a rejected reservation', async () => {
    const { checkRateLimit, reserveAuthenticationAttempt } = await import('../rate-limit')
    await checkRateLimit('192.0.2.44')
    await checkRateLimit('192.0.2.44')
    const denied = await reserveAuthenticationAttempt('192.0.2.44')
    expect(denied.allowed).toBe(false)
    denied.refund()
    expect((await checkRateLimit('192.0.2.44')).allowed).toBe(false)
  })

  it('counts in-flight attempts before they authenticate and returns capacity after success', async () => {
    vi.mocked(getTierLimits).mockResolvedValue(OSS_TIER_LIMITS)
    const { checkRateLimit, reserveAuthenticationAttempt } = await import('../rate-limit')
    const reservations = await Promise.all(
      Array.from({ length: 101 }, () => reserveAuthenticationAttempt('192.0.2.45'))
    )
    expect(reservations.filter((result) => result.allowed)).toHaveLength(100)
    for (const reservation of reservations) reservation.refund()
    for (let i = 0; i < 100; i++) {
      expect((await checkRateLimit('192.0.2.45')).allowed).toBe(true)
    }
    expect((await checkRateLimit('192.0.2.45')).allowed).toBe(false)
  })
})
