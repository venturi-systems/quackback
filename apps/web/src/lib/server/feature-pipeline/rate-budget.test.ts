import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/server/db', () => ({ db: {}, sql: vi.fn() }))
import { rateLimitRetryAt } from './rate-budget'
describe('GitHub rate-limit response backoff', () => {
  const now = Date.parse('2026-10-02T00:00:00Z')
  it('respects secondary limits and primary reset boundaries', () => {
    expect(rateLimitRetryAt(429, new Headers({ 'retry-after': '120' }), now)?.getTime()).toBe(
      now + 120000
    )
    expect(
      rateLimitRetryAt(
        403,
        new Headers({
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String((now + 3600000) / 1000),
        }),
        now
      )?.getTime()
    ).toBe(now + 3600000)
  })
  it('reserves capacity before exhaustion and does not pause ordinary responses', () => {
    expect(
      rateLimitRetryAt(200, new Headers({ 'x-ratelimit-remaining': '49' }), now)?.getTime()
    ).toBe(now + 60000)
    expect(rateLimitRetryAt(200, new Headers({ 'x-ratelimit-remaining': '500' }), now)).toBeNull()
    expect(rateLimitRetryAt(404, new Headers(), now)).toBeNull()
  })
})
