import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  type Row = {
    id: string
    feature_flags: string | null
    help_center_config: string | null
    widget_config: string | null
  }
  type Fault = 'temporary-write' | undefined
  const state = {
    row: { id: 'settings-owned' } as Row,
    files: new Map<string, string>(),
    modes: new Map<string, number>(),
    fault: undefined as Fault,
    calls: [] as string[],
  }
  function owned(path: unknown) {
    const text = String(path)
    if (
      !text.endsWith('/e2e/.auth/help-center.json') &&
      !text.endsWith('/e2e/.auth/help-center.json.tmp')
    ) {
      throw new Error('Unexpected fixture filesystem path')
    }
    return text.endsWith('.tmp') ? 'temporary' : 'snapshot'
  }
  const sql = Object.assign(
    vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      // postgres.js refuses an undefined parameter (UNDEFINED_VALUE) before it
      // sends the query; the fixture must never reach that.
      if (values.includes(undefined)) {
        throw Object.assign(new Error('Undefined values are not allowed'), {
          code: 'UNDEFINED_VALUE',
        })
      }
      const statement = parts.join('?').replace(/\s+/g, ' ').trim()
      if (
        statement ===
        'SELECT id, feature_flags, help_center_config, widget_config FROM settings ORDER BY created_at LIMIT 1'
      ) {
        state.calls.push('select')
        return [{ ...state.row }]
      }
      if (values.at(-1) !== state.row.id) throw new Error('Unexpected settings row')
      if (
        statement ===
        'UPDATE settings SET feature_flags = ?, help_center_config = ?, widget_config = ? WHERE id = ?'
      ) {
        state.calls.push('update-three')
        const [flags, config, widget] = values as (string | null)[]
        Object.assign(state.row, {
          feature_flags: flags,
          help_center_config: config,
          widget_config: widget,
        })
        return []
      }
      if (
        statement === 'UPDATE settings SET feature_flags = ?, help_center_config = ? WHERE id = ?'
      ) {
        state.calls.push('update-two')
        const [flags, config] = values as (string | null)[]
        Object.assign(state.row, { feature_flags: flags, help_center_config: config })
        return []
      }
      throw new Error('Unexpected fixture query: ' + statement)
    }),
    { end: vi.fn(async () => {}) }
  )
  return {
    state,
    sql,
    connect: vi.fn(() => sql),
    mkdirSync: vi.fn((path: unknown) => {
      if (!String(path).endsWith('/e2e/.auth')) throw new Error('Unexpected directory')
    }),
    writeFileSync: vi.fn(
      (path: unknown, value: string, options: { flag: string; mode: number }) => {
        const name = owned(path)
        state.calls.push(name + '-write')
        if (name === 'snapshot' && options.flag !== 'wx') {
          throw new Error('The snapshot itself is only ever created exclusively')
        }
        if (name === 'temporary' && state.fault === 'temporary-write') {
          state.fault = undefined
          throw new Error('temporary-write')
        }
        if (options.flag === 'wx' && state.files.has(String(path))) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' })
        }
        state.files.set(String(path), value)
        state.modes.set(String(path), options.mode)
      }
    ),
    readFileSync: vi.fn((path: unknown) => {
      owned(path)
      state.calls.push('snapshot-read')
      const value = state.files.get(String(path))
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return value
    }),
    renameSync: vi.fn((from: unknown, to: unknown) => {
      if (owned(from) !== 'temporary' || owned(to) !== 'snapshot') {
        throw new Error('Unexpected rename')
      }
      state.calls.push('snapshot-rename')
      const value = state.files.get(String(from))
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      state.files.set(String(to), value)
      state.modes.set(String(to), state.modes.get(String(from))!)
      state.files.delete(String(from))
      state.modes.delete(String(from))
    }),
    unlinkSync: vi.fn((path: unknown) => {
      owned(path)
      state.calls.push('snapshot-remove')
      state.files.delete(String(path))
      state.modes.delete(String(path))
    }),
    del: vi.fn(async () => {
      state.calls.push('cache')
    }),
    quit: vi.fn(async () => {}),
  }
})

// Execute the real CLI module, replacing only its external boundaries. No stored
// snapshot, database, Redis, subprocess or browser can be reached by these tests.
// Mock the ESM/Bun export, not postgres' distinct CommonJS package entry.
vi.mock('../apps/web/node_modules/postgres/src/index.js', () => ({ default: fixture.connect }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: fixture.mkdirSync,
  writeFileSync: fixture.writeFileSync,
  readFileSync: fixture.readFileSync,
  renameSync: fixture.renameSync,
  unlinkSync: fixture.unlinkSync,
}))
vi.mock('../apps/web/src/lib/server/redis', () => ({
  CACHE_KEYS: { TENANT_SETTINGS: 'tenant-settings' },
  getRedis: () => ({ del: fixture.del, quit: fixture.quit }),
}))

const originalArgv = process.argv
const original = {
  id: 'settings-owned',
  feature_flags: ' { "helpCenter": false, "kept": [1, "flag"] } ',
  help_center_config: '{"enabled":false,"title":"Acme help"}',
  widget_config: '{"enabled":false,"identifyVerification":true}',
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.state.row = { ...original }
  fixture.state.files = new Map()
  fixture.state.modes = new Map()
  fixture.state.fault = undefined
  fixture.state.calls = []
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/quackback_test')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Run the CLI once and return its exit code (0 on success). */
async function run(action: 'enable' | 'restore') {
  // Each assertion after a run reads that run's calls only.
  vi.clearAllMocks()
  fixture.state.calls = []
  vi.resetModules()
  process.argv = [originalArgv[0], 'set-help-center-enabled.ts', action]
  process.exitCode = undefined
  await import('../apps/web/e2e/scripts/set-help-center-enabled')
  expect(fixture.connect).toHaveBeenCalledWith('postgres://localhost:5432/quackback_test')
  // Every run, failed or not, closes both clients.
  expect(fixture.sql.end).toHaveBeenCalledOnce()
  expect(fixture.quit).toHaveBeenCalledOnce()
  const code = process.exitCode ?? 0
  process.exitCode = undefined
  return code
}

const SNAPSHOT_PATH = fileURLToPath(
  new URL('../apps/web/e2e/.auth/help-center.json', import.meta.url)
)

function snapshotKey() {
  return fixture.state.files.has(SNAPSHOT_PATH) ? SNAPSHOT_PATH : undefined
}

function saved() {
  const key = snapshotKey()
  return key === undefined ? null : JSON.parse(fixture.state.files.get(key)!)
}

/** Put a snapshot on disk as an earlier run of the script would have left it. */
function storeSnapshot(value: unknown) {
  fixture.state.files.set(SNAPSHOT_PATH, JSON.stringify(value))
  fixture.state.modes.set(SNAPSHOT_PATH, 0o600)
}

function expectOriginal() {
  expect(fixture.state.row).toEqual(original)
}

function expectEnabled() {
  expect(JSON.parse(fixture.state.row.feature_flags!).helpCenter).toBe(true)
  expect(JSON.parse(fixture.state.row.help_center_config!).enabled).toBe(true)
  expect(JSON.parse(fixture.state.row.widget_config!).enabled).toBe(true)
}

describe('help-center fixture restoration', () => {
  it.each([
    { name: 'configured columns', columns: original },
    {
      name: 'null columns',
      columns: { feature_flags: null, help_center_config: null, widget_config: null },
    },
  ])('restores the exact $name after enable', async ({ columns }) => {
    Object.assign(fixture.state.row, columns)
    const before = { ...fixture.state.row }

    expect(await run('enable')).toBe(0)
    expectEnabled()
    expect(saved()).toEqual(before)
    expect(fixture.state.modes.get(snapshotKey()!)).toBe(0o600)

    expect(await run('restore')).toBe(0)
    expect(fixture.state.row).toEqual(before)
    expect(saved()).toBeNull()
  })

  it('keeps the original snapshot when enable is retried', async () => {
    expect(await run('enable')).toBe(0)
    expect(await run('enable')).toBe(0)
    expectEnabled()
    expect(saved()).toEqual(original)

    expect(await run('restore')).toBe(0)
    expectOriginal()
  })

  it('treats a missing snapshot as nothing to restore', async () => {
    expect(await run('restore')).toBe(0)
    expect(fixture.sql).not.toHaveBeenCalled()
    expectOriginal()
  })
})

describe('help-center snapshots written before widget_config was captured', () => {
  /** What the older script left: two columns enabled and no widget column. */
  function legacyEnable(widgetConfig: string | null) {
    fixture.state.row.widget_config = widgetConfig
    storeSnapshot({
      id: original.id,
      feature_flags: original.feature_flags,
      help_center_config: original.help_center_config,
    })
    fixture.state.row.feature_flags = '{"helpCenter":true}'
    fixture.state.row.help_center_config = '{"enabled":true}'
  }

  it.each([
    { name: 'a configured widget', widgetConfig: original.widget_config },
    { name: 'a null widget column', widgetConfig: null },
  ])('upgrades the snapshot before enable changes $name', async ({ widgetConfig }) => {
    legacyEnable(widgetConfig)

    expect(await run('enable')).toBe(0)
    // Recorded through a temporary file before the widget is enabled.
    expect(fixture.state.calls).toEqual([
      'select',
      'snapshot-write',
      'snapshot-read',
      'temporary-write',
      'snapshot-rename',
      'update-three',
      'cache',
    ])
    expectEnabled()
    expect(saved()).toEqual({ ...original, widget_config: widgetConfig })
    expect(fixture.state.modes.get(snapshotKey()!)).toBe(0o600)

    expect(await run('restore')).toBe(0)
    expect(fixture.state.row).toEqual({ ...original, widget_config: widgetConfig })
    expect(saved()).toBeNull()
  })

  it('restores the two stored columns when no enable has upgraded it', async () => {
    legacyEnable(original.widget_config)

    expect(await run('restore')).toBe(0)
    expect(fixture.state.calls).toContain('update-two')
    expect(fixture.state.calls).not.toContain('update-three')
    expectOriginal()
    expect(saved()).toBeNull()
  })

  it('leaves the fixture unchanged when the upgrade cannot be written', async () => {
    legacyEnable(original.widget_config)
    const before = { ...fixture.state.row }
    fixture.state.fault = 'temporary-write'

    expect(await run('enable')).toBe(1)
    expect(fixture.state.row).toEqual(before)
    expect(saved()).not.toHaveProperty('widget_config')

    // The retained snapshot still restores the run that wrote it.
    expect(await run('restore')).toBe(0)
    expectOriginal()
  })

  it('refuses a snapshot of another settings row before enabling anything', async () => {
    legacyEnable(original.widget_config)
    storeSnapshot({
      id: 'settings-other',
      feature_flags: original.feature_flags,
      help_center_config: original.help_center_config,
    })
    const before = { ...fixture.state.row }

    expect(await run('enable')).toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Help-center snapshot names another settings row')
    )
    expect(fixture.state.row).toEqual(before)
  })
})

describe('malformed help-center snapshots', () => {
  it.each([
    { name: 'a missing column', value: { id: original.id, feature_flags: null } },
    { name: 'a numeric id', value: { ...original, id: 7 } },
    { name: 'a non-text widget column', value: { ...original, widget_config: { enabled: false } } },
    { name: 'an array', value: [original] },
  ])('fail before any query binds a value from $name', async ({ value }) => {
    storeSnapshot(value)
    const before = { ...fixture.state.row }

    expect(await run('restore')).toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Malformed help-center snapshot')
    )
    expect(fixture.state.calls).not.toContain('update-two')
    expect(fixture.state.calls).not.toContain('update-three')
    expect(fixture.state.row).toEqual(before)
    expect(saved()).toEqual(value)

    expect(await run('enable')).toBe(1)
    expect(fixture.state.row).toEqual(before)
  })
})
