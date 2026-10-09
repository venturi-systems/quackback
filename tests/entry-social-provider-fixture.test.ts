import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  type Row = { id: string; integrationType: string; ciphertext: string }
  const state = {
    rows: new Map<string, Row>(),
    version: 0,
    refuseGuard: false,
    failCache: false,
    failCleanupReadback: false,
  }
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.join('?').replace(/\s+/g, ' ').trim()
    if (statement.startsWith('INSERT INTO integration_platform_credentials')) {
      const [id, integrationType, ciphertext, ownedId] = values as string[]
      expect(ownedId).toBe(id)
      expect(statement).toContain('WHERE integration_platform_credentials.id = ?')
      const previous = state.rows.get(integrationType)
      if (previous && previous.id !== id) return []
      state.rows.set(integrationType, { id, integrationType, ciphertext })
      return [{ id }]
    }
    if (statement.startsWith('DELETE FROM integration_platform_credentials')) {
      expect(statement).toContain('WHERE id = ? AND integration_type = ?')
      const [id, integrationType] = values as string[]
      if (state.rows.get(integrationType)?.id === id) state.rows.delete(integrationType)
      return []
    }
    if (statement.startsWith('SELECT id FROM integration_platform_credentials')) {
      const [id, integrationType] = values as string[]
      if (state.failCleanupReadback) throw new Error('private-driver-parameter')
      const row = state.rows.get(integrationType)
      return row?.id === id ? [{ id }] : []
    }
    if (statement === 'UPDATE settings SET auth_config_version = auth_config_version + 1') {
      state.version += 1
      return []
    }
    throw new Error('Unexpected fixture query')
  })
  const connection = {
    begin: vi.fn(async (callback: (tx: typeof query) => Promise<void>) => {
      const before = new Map(state.rows)
      const version = state.version
      try {
        await callback(query)
      } catch (error) {
        state.rows = before
        state.version = version
        throw error
      }
    }),
    end: vi.fn(async () => {}),
  }
  return {
    state,
    query,
    connection,
    connect: vi.fn(() => connection),
    guard: vi.fn(async () => {
      if (state.refuseGuard) throw new Error('Not an isolated fixture')
    }),
    encrypt: vi.fn((credentials: Record<string, string>) => JSON.stringify(credentials)),
    del: vi.fn(async () => {
      if (state.failCache) throw new Error('private-driver-parameter')
    }),
    quit: vi.fn(async () => {}),
  }
})

vi.mock('../apps/web/node_modules/postgres/src/index.js', () => ({ default: fixture.connect }))
vi.mock('../apps/web/e2e/utils/design-fixture-guard', () => ({
  assertDesignFixtureEnvironment: fixture.guard,
}))
vi.mock('../apps/web/src/lib/server/integrations/encryption', () => ({
  encryptPlatformCredentials: fixture.encrypt,
}))
vi.mock('../apps/web/src/lib/server/redis', () => ({
  CACHE_KEYS: { TENANT_SETTINGS: 'tenant-settings', PLATFORM_INTEGRATION_TYPES: 'platform-types' },
  getRedis: () => ({ del: fixture.del, quit: fixture.quit }),
}))

const originalArgv = process.argv
const originalExitCode = process.exitCode
beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.rows = new Map()
  fixture.state.version = 0
  fixture.state.refuseGuard = false
  fixture.state.failCache = false
  fixture.state.failCleanupReadback = false
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/quackback_test')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
async function run(action: string) {
  vi.resetModules()
  process.argv = [originalArgv[0], 'set-entry-social-providers.ts', action]
  process.exitCode = 0
  await import('../apps/web/e2e/scripts/set-entry-social-providers')
  return process.exitCode
}

describe('REQ-FEEDBACK-AUTH-VIEWPORT isolated social provider fixture', () => {
  it('proves fixture ownership before connecting, encrypting or changing state', async () => {
    fixture.state.refuseGuard = true
    expect(await run('seed')).toBe(1)
    expect(fixture.guard).toHaveBeenCalledOnce()
    expect(fixture.connect).not.toHaveBeenCalled()
    expect(fixture.encrypt).not.toHaveBeenCalled()
    expect(fixture.del).not.toHaveBeenCalled()
  })

  it('seeds both complete dummy credentials idempotently and invalidates auth caches', async () => {
    expect(await run('seed')).toBe(0)
    const first = [...fixture.state.rows.values()]
    expect(first.map((row) => row.integrationType)).toEqual(['auth_google', 'auth_github'])
    expect(fixture.encrypt.mock.calls.map(([credentials]) => credentials)).toEqual([
      { clientId: 'e2e-entry-google-client', clientSecret: 'e2e-entry-google-secret' },
      { clientId: 'e2e-entry-github-client', clientSecret: 'e2e-entry-github-secret' },
    ])
    expect(await run('seed')).toBe(0)
    expect([...fixture.state.rows.values()]).toEqual(first)
    expect(fixture.state.version).toBe(2)
    expect(fixture.del).toHaveBeenLastCalledWith('tenant-settings', 'platform-types')
    expect(fixture.connection.end).toHaveBeenCalledTimes(2)
    expect(fixture.quit).toHaveBeenCalledTimes(2)
  })

  it('rolls back the whole seed when another fixture owns either provider', async () => {
    const previous = { id: 'other-fixture', integrationType: 'auth_github', ciphertext: 'kept' }
    fixture.state.rows.set(previous.integrationType, previous)
    expect(await run('seed')).toBe(1)
    expect([...fixture.state.rows.values()]).toEqual([previous])
    expect(fixture.state.version).toBe(0)
    expect(fixture.del).not.toHaveBeenCalled()
  })

  it('removes only its own IDs and preserves unrelated credentials', async () => {
    expect(await run('seed')).toBe(0)
    const previous = { id: 'other-fixture', integrationType: 'auth_google', ciphertext: 'kept' }
    fixture.state.rows.set(previous.integrationType, previous)
    expect(await run('remove')).toBe(0)
    expect([...fixture.state.rows.values()]).toEqual([previous])
    expect(await run('remove')).toBe(0)
    expect([...fixture.state.rows.values()]).toEqual([previous])
  })

  it('retains a recoverable transaction when cleanup readback fails', async () => {
    expect(await run('seed')).toBe(0)
    const first = [...fixture.state.rows.values()]
    fixture.state.failCleanupReadback = true
    expect(await run('remove')).toBe(1)
    expect([...fixture.state.rows.values()]).toEqual(first)
    fixture.state.failCleanupReadback = false
    expect(await run('remove')).toBe(0)
    expect(fixture.state.rows.size).toBe(0)
  })

  it('can clean up a committed seed after cache failure without printing parameters', async () => {
    fixture.state.failCache = true
    expect(await run('seed')).toBe(1)
    expect(fixture.state.rows.size).toBe(2)
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private-driver')
    fixture.state.failCache = false
    expect(await run('remove')).toBe(0)
    expect(fixture.state.rows.size).toBe(0)
    expect(fixture.quit).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported actions without opening a connection', async () => {
    expect(await run('other')).toBe(1)
    expect(fixture.guard).not.toHaveBeenCalled()
    expect(fixture.connect).not.toHaveBeenCalled()
  })
})
