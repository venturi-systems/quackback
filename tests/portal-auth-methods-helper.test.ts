import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  type Row = { id: string; auth_config: string | null; portal_config: string | null }
  type Fault = 'snapshot-write' | 'update-before' | 'update-after' | 'cache' | undefined
  type ReadbackFault = 'auth-mismatch' | 'portal-mismatch' | 'missing-row' | 'read-failure'
  const state = {
    row: { id: 'settings-owned', auth_config: null, portal_config: null } as Row,
    snapshot: null as string | null,
    fault: undefined as Fault,
    readbackFault: undefined as ReadbackFault | undefined,
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
      if (statement === 'SELECT auth_config, portal_config FROM settings WHERE id = ?') {
        state.calls.push('restore-readback')
        if (values[0] !== state.row.id) throw new Error('Unexpected readback settings row')
        const fault = state.readbackFault
        state.readbackFault = undefined
        if (fault === 'read-failure') {
          throw new Error('private-driver-detail: ' + JSON.stringify(state.row))
        }
        if (fault === 'missing-row') return []
        const restored = { ...state.row }
        if (fault === 'auth-mismatch' || fault === 'portal-mismatch') {
          const column = fault === 'auth-mismatch' ? 'auth_config' : 'portal_config'
          // Equivalent JSON text still differs from the snapshot; NULL is not ''.
          restored[column] = restored[column] === null ? '' : restored[column] + '\n'
        }
        return [restored]
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
    del: vi.fn(async () => {
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
  getRedis: () => ({ del: fixture.del, quit: fixture.quit }),
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
  fixture.state.readbackFault = undefined
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
    expect(fixture.state.calls.slice(-4)).toEqual([
      'update',
      'restore-readback',
      'snapshot-remove',
      'cache',
    ])
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({ action: 'restore', restorationReadback: 'matched' })
    )
    expect(fixture.del).toHaveBeenCalledTimes(2)
    expect(fixture.sql.end).toHaveBeenCalledTimes(2)
    expect(fixture.quit).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'null columns', authConfig: null, portalConfig: null },
    {
      name: 'social and email methods with admission settings',
      authConfig:
        ' { "oauth": { "password": true, "magicLink": true, "google": false, "github": false, "custom": false }, "openSignup": false } ',
      portalConfig: original.portalConfig,
    },
  ])('restores exact $name after the social-only viewport fixture', async (initial) => {
    fixture.state.row.auth_config = initial.authConfig
    fixture.state.row.portal_config = initial.portalConfig
    await run('enable-social-only-temporarily')
    const active = JSON.parse(fixture.state.row.auth_config!)
    expect(active.oauth.google).toBe(true)
    expect(active.oauth.github).toBe(true)
    expect(active.oauth.password).toBe(false)
    expect(active.oauth.magicLink).toBe(false)
    if (initial.authConfig !== null) {
      const previous = JSON.parse(initial.authConfig)
      expect(active).toEqual({
        ...previous,
        oauth: { ...previous.oauth, google: true, github: true, password: false, magicLink: false },
      })
    }
    expect(fixture.state.row.portal_config).toBe(initial.portalConfig)
    expect(fixture.state.calls.indexOf('snapshot-write')).toBeLessThan(
      fixture.state.calls.indexOf('update')
    )
    await run('restore')
    expect(fixture.state.row.auth_config).toBe(initial.authConfig)
    expect(fixture.state.row.portal_config).toBe(initial.portalConfig)
    expect(fixture.state.snapshot).toBeNull()
    expect(fixture.state.calls.slice(-4)).toEqual([
      'update',
      'restore-readback',
      'snapshot-remove',
      'cache',
    ])
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
    ['enable-social-only-temporarily', 'enable-magic-link-temporarily'],
    ['enable-magic-link-temporarily', 'enable-social-only-temporarily'],
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
    expect(fixture.state.calls).not.toContain('restore-readback')
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({ action: 'restore', restorationReadback: 'no-snapshot' })
    )
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
    expect(fixture.del).not.toHaveBeenCalled()
  })

  it.each(['update-before', 'update-after', 'cache'] as const)(
    'keeps a recoverable snapshot when enabling fails at %s',
    async (stage) => {
      fixture.state.fault = stage
      await expect(run('enable-magic-link-temporarily')).rejects.toThrow('CLI exit 1')
      expect(console.error).toHaveBeenCalledWith(
        stage === 'cache'
          ? 'Portal auth cache invalidation failed; retry the fixture action'
          : stage
      )
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

  it.each([
    { fault: 'auth-mismatch', columns: 'configured', ...original },
    { fault: 'portal-mismatch', columns: 'configured', ...original },
    { fault: 'auth-mismatch', columns: 'NULL', authConfig: null, portalConfig: null },
    { fault: 'portal-mismatch', columns: 'NULL', authConfig: null, portalConfig: null },
  ] as const)(
    'retains the snapshot on $fault for $columns columns and allows retry',
    async (initial) => {
      fixture.state.row.auth_config = initial.authConfig
      fixture.state.row.portal_config = initial.portalConfig
      await run('enable-magic-link-temporarily')
      const snapshot = fixture.state.snapshot
      fixture.state.readbackFault = initial.fault

      await expect(run('restore')).rejects.toThrow(
        'Portal auth restoration readback mismatch; snapshot retained'
      )
      expect(fixture.state.snapshot).toBe(snapshot)
      expect(fixture.state.calls).not.toContain('snapshot-remove')
      expect(fixture.del).toHaveBeenCalledTimes(1)
      expect(console.log).toHaveBeenCalledTimes(1)
      expect(console.error).toHaveBeenLastCalledWith(
        'Portal auth restoration readback mismatch; snapshot retained'
      )

      await run('restore')
      expect(fixture.state.row.auth_config).toBe(initial.authConfig)
      expect(fixture.state.row.portal_config).toBe(initial.portalConfig)
      expect(fixture.state.snapshot).toBeNull()
      expect(console.log).toHaveBeenLastCalledWith(
        JSON.stringify({ action: 'restore', restorationReadback: 'matched' })
      )
    }
  )

  it('retains the snapshot when the restored row is missing and allows retry', async () => {
    await run('enable-magic-link-temporarily')
    const snapshot = fixture.state.snapshot
    fixture.state.readbackFault = 'missing-row'
    await expect(run('restore')).rejects.toThrow(
      'Portal auth restoration readback mismatch; snapshot retained'
    )
    expect(fixture.state.snapshot).toBe(snapshot)
    expect(fixture.state.calls).not.toContain('snapshot-remove')
    expect(fixture.del).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledTimes(1)
    await run('restore')
    expectOriginal()
    expect(fixture.state.snapshot).toBeNull()
  })

  it('retains the snapshot on readback failure without logging driver configuration', async () => {
    await run('enable-magic-link-temporarily')
    const snapshot = fixture.state.snapshot
    fixture.state.readbackFault = 'read-failure'
    await expect(run('restore')).rejects.toThrow(
      'Portal auth restoration readback failed; snapshot retained'
    )
    expect(fixture.state.snapshot).toBe(snapshot)
    expect(fixture.state.calls).not.toContain('snapshot-remove')
    expect(fixture.del).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledTimes(1)
    expect(console.error).toHaveBeenCalledWith(
      'Portal auth restoration readback failed; snapshot retained'
    )
    const output = JSON.stringify([
      ...vi.mocked(console.log).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ])
    expect(output).not.toContain('private-driver-detail')
    expect(output).not.toContain('Acme feedback')
    expect(output).not.toContain('auth_config')
    expect(output).not.toContain('portal_config')
    await run('restore')
    expectOriginal()
    expect(fixture.state.snapshot).toBeNull()
  })

  it('retries cache invalidation after the settings were already restored', async () => {
    await run('enable-magic-link-temporarily')
    fixture.state.fault = 'cache'
    await expect(run('restore')).rejects.toThrow('CLI exit 1')
    expectOriginal()
    await run('restore')
    expectOriginal()
    expect(fixture.del).toHaveBeenCalledTimes(3)
  })
})
