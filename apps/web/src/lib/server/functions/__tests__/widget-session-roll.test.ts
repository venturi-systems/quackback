import { describe, it, expect } from 'vitest'
import { shouldRollSession, WIDGET_SESSION_TTL_MS } from '../widget-session-roll'

describe('shouldRollSession', () => {
  const now = 1_700_000_000_000

  it('rolls when there is no prior update timestamp', () => {
    expect(shouldRollSession(null, now)).toBe(true)
  })

  it('rolls once the 24h updateAge window has elapsed', () => {
    expect(shouldRollSession(new Date(now - 25 * 60 * 60 * 1000), now)).toBe(true)
    expect(shouldRollSession(new Date(now - 24 * 60 * 60 * 1000), now)).toBe(true)
  })

  it('does not roll within the 24h window (mirrors Better Auth updateAge)', () => {
    expect(shouldRollSession(new Date(now - 60 * 60 * 1000), now)).toBe(false)
    expect(shouldRollSession(new Date(now), now)).toBe(false)
  })

  it('exposes the 7-day session TTL', () => {
    expect(WIDGET_SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
