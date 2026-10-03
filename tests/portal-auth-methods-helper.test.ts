import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  type Row = { id: string; auth_config: string | null; portal_config: string | null }
  type Fault = 'snapshot-write' | 'update-before' | 'update-after' | 'cache' | undefined
  const state = {
    row: { id: 'settings-owned', auth_config: null, portal_config: null } as Row,
    snapshot: null as string | null,
    fault: undefined as Fault,
    calls: [] as string[],
  }
  function fail(stage: Fault) {
    if (state.fault === stage) {
      state.fault = undefined
      throw new Error(stage)
    }
  }
  function snapshotPath(path: unknown) {
    if (!String(path).endsWith('/.auth/portal-auth-snapshot.json')) {
      throw new Error('Unexpected fixture filesystem path')
    }
  }
  const sql = Object.assign(
    vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const statement = parts.join('?').replace(/\s+/g, ' ').trim()
      if (statement.startsWith('SELECT id, auth_config, portal_config FROM settings')) {
        state.calls.push('select')
        return [{ ...state.row }]
      }
      if (!statement.startsWith('UPDATE settings SET auth_config = ?')) {
        throw new Error('Unexpected fixture query: ' + statement)
      }
      state.calls.push('update')
      if (values.at(-1) !== state.row.id) throw new Error('Unexpected settings row')
      fail('update-before')
      state.row.auth_config = values[0] as string | null
      if (statement.includes('portal_config = ?')) {
        state.row.portal_config = values[1] as string | null
      }
      fail('update-after')
      return []
    }),
    { end: vi.fn(async () => {}) }
  )
  return {
    state,
    sql,
    connect: vi.fn(() => sql),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((path: unknown, value: string, options: { flag: string }) => {
      snapshotPath(path)
      state.calls.push('snapshot-write')
      if (options.flag !== 'wx') throw new Error('Snapshot must be exclusive')
      fail('snapshot-write')
      if (state.snapshot !== null) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      }
      state.snapshot = value
    }),
    readFileSync: vi.fn((path: unknown) => {
      snapshotPath(path)
      state.calls.push('snapshot-read')
      if (state.snapshot === null) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return state.snapshot
    }),
    rmSync: vi.fn((path: unknown) => {
      snapshotPath(path)
      state.calls.push('snapshot-remove')
      state.snapshot = null
    }),
    cacheDel: vi.fn(async () => {
      state.calls.push('cache')
      fail('cache')
    }),
    quit: vi.fn(async () => {}),
  }
})

// Execute the real CLI module, replacing only its external boundaries. No stored
// auth files, database, Redis, subprocess, or browser can be reached by these tests.
// Mock the ESM/Bun export, not postgres' distinct CommonJS package entry.
vi.mock('../apps/web/node_modules/postgres/src/index.js', () => ({ default: fixture.connect }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: fixture.mkdirSync,
  writeFileSync: fixture.writeFileSync,
  readFileSync: fixture.readFileSync,
  rmSync: fixture.rmSync,
}))
vi.mock('../apps/web/src/lib/server/redis', () => ({
  CACHE_KEYS: { TENANT_SETTINGS: 'tenant-settings' },
  cacheDel: fixture.cacheDel,
  getRedis: () => ({ quit: fixture.quit }),
}))

const originalArgv = process.argv
const original = {
  authConfig:
    ' { "oauth": { "password": false, "magicLink": false, "custom": true }, "openSignup": false, "unknown": [1, "kept"] } ',
  portalConfig: ' { "oauth": { "custom": true }, "title": "Acme feedback" } ',
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.row = {
    id: 'settings-owned',
    auth_config: original.authConfig,
    portal_config: original.portalConfig,
  }
  fixture.state.snapshot = null
  fixture.state.fault = undefined
  fixture.state.calls = []
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/quackback_test')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(
      'CLI exit ' + code + ': ' + vi.mocked(console.error).mock.calls.at(-1)?.join(' ')
    )
  })
})

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function run(action: string) {
  vi.resetModules()
  process.argv = [originalArgv[0], 'set-portal-auth-methods.ts', action]
  const connections = fixture.connect.mock.calls.length
  try {
    await import('../apps/web/e2e/scripts/set-portal-auth-methods')
  } finally {
    expect(fixture.connect).toHaveBeenCalledTimes(connections + 1)
    expect(fixture.connect).toHaveBeenLastCalledWith('postgres://localhost:5432/quackback_test')
  }
}

function saved() {
  return fixture.state.snapshot === null ? null : JSON.parse(fixture.state.snapshot)
}

function expectOriginal() {
  expect(fixture.state.row.auth_config).toBe(original.authConfig)
  expect(fixture.state.row.portal_config).toBe(original.portalConfig)
}

describe('portal auth helper temporary magic-link restoration', () => {
  it.each([
    { name: 'null columns', authConfig: null, portalConfig: null },
    { name: 'configured columns including whitespace', ...original },
    {
      name: 'already enabled magic link',
      authConfig: '{"oauth":{"magicLink":true,"password":false},"custom":"kept"}',
      portalConfig: '{"title":"Acme feedback"}',
    },
  ])('restores the exact $name after temporary enable', async (initial) => {
    fixture.state.row.auth_config = initial.authConfig
    fixture.state.row.portal_config = initial.portalConfig

    await run('enable-magic-link-temporarily')
    const snapshot = saved()
    expect(JSON.parse(fixture.state.row.auth_config!).oauth.magicLink).toBe(true)
    expect(fixture.state.row.portal_config).toBe(initial.portalConfig)
    expect(fixture.state.calls.indexOf('snapshot-write')).toBeLessThan(
      fixture.state.calls.indexOf('update')
    )

    await run('restore')
    expect(fixture.state.row.auth_config).toBe(initial.authConfig)
    expect(fixture.state.row.portal_config).toBe(initial.portalConfig)
    expect(snapshot).toEqual({
      authConfig: initial.authConfig,
      portalConfig: initial.portalConfig,
    })
    expect(fixture.state.snapshot).toBeNull()
    expect(fixture.cacheDel).toHaveBeenCalledTimes(2)
    expect(fixture.sql.end).toHaveBeenCalledTimes(2)
    expect(fixture.quit).toHaveBeenCalledTimes(2)
  })

  it('changes only magicLink while temporary enable is active', async () => {
    await run('enable-magic-link-temporarily')
    expect(JSON.parse(fixture.state.row.auth_config!)).toEqual({
      ...JSON.parse(original.authConfig),
      oauth: { ...JSON.parse(original.authConfig).oauth, magicLink: true },
    })
    expect(fixture.state.row.portal_config).toBe(original.portalConfig)
  })

  it.each([
    ['enable-magic-link-temporarily', 'enable-magic-link-temporarily'],
    ['enable-magic-link-temporarily', 'disable'],
    ['disable', 'enable-magic-link-temporarily'],
  ])('keeps the first snapshot across %s then %s', async (first, second) => {
    await run(first)
    const snapshot = fixture.state.snapshot
    await run(second)
    expect(fixture.state.snapshot).toBe(snapshot)
    expect(saved()).toEqual(original)
    await run('restore')
    expectOriginal()
    expect(fixture.state.snapshot).toBeNull()
  })

  it('preserves permanent setup semantics without creating a snapshot', async () => {
    await run('enable-magic-link')
    const enabled = fixture.state.row.auth_config
    expect(JSON.parse(enabled!).oauth.magicLink).toBe(true)
    expect(fixture.writeFileSync).not.toHaveBeenCalled()
    expect(fixture.state.snapshot).toBeNull()
    const updates = fixture.state.calls.filter((call) => call === 'update').length
    await run('restore')
    expect(fixture.state.row.auth_config).toBe(enabled)
    expect(fixture.state.calls.filter((call) => call === 'update')).toHaveLength(updates)
  })

  it('does not replace an existing snapshot during permanent setup', async () => {
    await run('disable')
    const snapshot = fixture.state.snapshot
    await run('enable-magic-link')
    expect(fixture.state.snapshot).toBe(snapshot)
    await run('restore')
    expectOriginal()
  })

  it('refuses to change settings when the snapshot write fails', async () => {
    fixture.state.fault = 'snapshot-write'
    await expect(run('enable-magic-link-temporarily')).rejects.toThrow('CLI exit 1')
    expect(console.error).toHaveBeenCalledWith('snapshot-write')
    expectOriginal()
    expect(fixture.state.calls).not.toContain('update')
    expect(fixture.cacheDel).not.toHaveBeenCalled()
  })

  it.each(['update-before', 'update-after', 'cache'] as const)(
    'keeps a recoverable snapshot when enabling fails at %s',
    async (stage) => {
      fixture.state.fault = stage
      await expect(run('enable-magic-link-temporarily')).rejects.toThrow('CLI exit 1')
      expect(console.error).toHaveBeenCalledWith(stage)
      expect(saved()).toEqual(original)
      if (stage === 'update-before') expectOriginal()
      else expect(JSON.parse(fixture.state.row.auth_config!).oauth.magicLink).toBe(true)
      await run('restore')
      expectOriginal()
      expect(fixture.state.snapshot).toBeNull()
    }
  )

  it.each(['update-before', 'update-after'] as const)(
    'can retry restoration after %s failure',
    async (stage) => {
      await run('enable-magic-link-temporarily')
      fixture.state.fault = stage
      await expect(run('restore')).rejects.toThrow('CLI exit 1')
      expect(saved()).toEqual(original)
      await run('restore')
      expectOriginal()
      expect(fixture.state.snapshot).toBeNull()
    }
  )

  it('retries cache invalidation after the settings were already restored', async () => {
    await run('enable-magic-link-temporarily')
    fixture.state.fault = 'cache'
    await expect(run('restore')).rejects.toThrow('CLI exit 1')
    expectOriginal()
    await run('restore')
    expectOriginal()
    expect(fixture.cacheDel).toHaveBeenCalledTimes(3)
  })
})
