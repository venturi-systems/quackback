import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetConfig } from '@/lib/server/config'
import { isTelemetryEnabled } from '../config'
import { startTelemetry } from '../index'

const { buildPayload, payload } = vi.hoisted(() => {
  const payload = { instanceId: 'fixture-only', scale: { users: '0', posts: '0', boards: '0' } }
  return { payload, buildPayload: vi.fn().mockResolvedValue(payload) }
})
vi.mock('../payload', () => ({ buildPayload }))
vi.mock('@/lib/server/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn() }) },
}))

const fetchMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }))
  buildPayload.mockClear()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('BASE_URL', 'http://localhost:3000')
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres:password@localhost:5432/quackback_test')
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379')
  vi.stubEnv('SECRET_KEY', 'test-only-secret-with-at-least-32-characters')
  vi.stubEnv('ENABLE_TELEMETRY', undefined)
  vi.stubEnv('DISABLE_TELEMETRY', undefined)
  resetConfig()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetConfig()
})

describe('optional reporting consent', () => {
  it.each([undefined, '', 'false', '0', '1', 'TRUE', ' true ', 'yes'])(
    'does not collect, send or schedule without literal consent (%s)',
    async (value) => {
      vi.stubEnv('ENABLE_TELEMETRY', value)
      expect(isTelemetryEnabled()).toBe(false)
      await startTelemetry()
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(buildPayload).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not treat an explicit false disable flag as consent', async () => {
    vi.stubEnv('DISABLE_TELEMETRY', 'false')
    await startTelemetry()
    expect(buildPayload).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([undefined, 'false', '0'])(
    'collects and schedules only after explicit opt-in when disable is %s',
    async (disable) => {
      vi.stubEnv('ENABLE_TELEMETRY', 'true')
      vi.stubEnv('DISABLE_TELEMETRY', disable)
      expect(isTelemetryEnabled()).toBe(true)
      await startTelemetry()
      expect(buildPayload).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://telemetry.quackback.io/v1/ping',
        expect.objectContaining({ method: 'POST', body: JSON.stringify(payload) })
      )
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(buildPayload).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['true', '1'])('preserves disable precedence (%s)', async (disable) => {
    vi.stubEnv('ENABLE_TELEMETRY', 'true')
    vi.stubEnv('DISABLE_TELEMETRY', disable)
    expect(isTelemetryEnabled()).toBe(false)
    await startTelemetry()
    expect(buildPayload).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
