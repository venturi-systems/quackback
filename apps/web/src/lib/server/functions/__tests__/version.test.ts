import { describe, it, expect } from 'vitest'
import { isNewerVersion } from '../version'

describe('isNewerVersion', () => {
  it('returns true when latest major is higher', () => {
    expect(isNewerVersion('0.4.5', '1.0.0')).toBe(true)
  })

  it('returns true when latest minor is higher', () => {
    expect(isNewerVersion('0.4.5', '0.5.0')).toBe(true)
  })

  it('returns true when latest patch is higher', () => {
    expect(isNewerVersion('0.4.5', '0.4.6')).toBe(true)
  })

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('0.4.5', '0.4.5')).toBe(false)
  })

  it('returns false when current is newer', () => {
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false)
  })

  it('returns false when latest minor is lower', () => {
    expect(isNewerVersion('0.5.0', '0.4.9')).toBe(false)
  })
})

describe('getLatestVersion upstream check switch', () => {
  it('returns null without calling GitHub unless UPSTREAM_VERSION_CHECK=true', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const handlers: Array<() => Promise<unknown>> = []
    vi.doMock('@tanstack/react-start', () => ({
      createServerFn: () => ({
        handler(fn: () => Promise<unknown>) {
          handlers.push(fn)
          return fn
        },
      }),
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubEnv('UPSTREAM_VERSION_CHECK', '')
    try {
      await import('../version')
      expect(await handlers[0]()).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      vi.doUnmock('@tanstack/react-start')
      vi.resetModules()
    }
  })
})
