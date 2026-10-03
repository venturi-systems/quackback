import { describe, expect, it, vi } from 'vitest'
import {
  runAuthAcceptanceFixture,
  type AuthFixtureDependencies,
  type AuthFixtureStore,
} from '../apps/web/e2e/scripts/set-auth-acceptance-fixture'
import { validateDesignFixtureEnvironment } from '../apps/web/e2e/utils/design-fixture-guard'

function fixture(initial: string | null = null) {
  let current = initial
  let rowId = 'settings-owned'
  let snapshot: unknown = null
  const store: AuthFixtureStore = {
    readSettings: vi.fn(async () => [{ id: rowId, authConfig: current }]),
    compareAndSet: vi.fn(async (id, expected, next) => {
      if (id !== rowId || current !== expected) return false
      current = next
      return true
    }),
    invalidateCache: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  const dependencies: AuthFixtureDependencies = {
    guard: vi.fn(),
    scope: () => ({ runId: '123', runAttempt: '2' }),
    readSnapshot: vi.fn(() => snapshot),
    writeSnapshot: vi.fn((value) => {
      if (snapshot !== null) throw new Error('snapshot already exists')
      snapshot = structuredClone(value)
    }),
    removeSnapshot: vi.fn(() => {
      snapshot = null
    }),
    connect: vi.fn(async () => store),
  }
  return {
    store,
    dependencies,
    current: () => current,
    snapshot: () => snapshot,
    setCurrent(value: string | null) {
      current = value
    },
    setRowId(value: string) {
      rowId = value
    },
    setSnapshot(value: unknown) {
      snapshot = value
    },
    run: (action: string) => runAuthAcceptanceFixture(action, dependencies),
  }
}

describe('auth acceptance fixture ownership', () => {
  it.each(['enable', 'restore'])('guards %s before file or client access', async (action) => {
    const f = fixture()
    f.dependencies.guard = () => validateDesignFixtureEnvironment({ CI: 'false' })
    await expect(f.run(action)).rejects.toThrow('isolated GitHub CI fixture')
    expect(f.dependencies.readSnapshot).not.toHaveBeenCalled()
    expect(f.dependencies.writeSnapshot).not.toHaveBeenCalled()
    expect(f.dependencies.connect).not.toHaveBeenCalled()
  })

  it('rejects a missing run identity before reading snapshots or constructing clients', async () => {
    const f = fixture()
    f.dependencies.scope = () => ({ runId: '', runAttempt: '2' })
    await expect(f.run('enable')).rejects.toThrow('invalid run identity')
    expect(f.dependencies.readSnapshot).not.toHaveBeenCalled()
    expect(f.dependencies.connect).not.toHaveBeenCalled()
  })

  it('rejects unknown actions before accessing any fixture', async () => {
    const f = fixture()
    await expect(f.run('reset')).rejects.toThrow('unknown action')
    expect(f.dependencies.guard).not.toHaveBeenCalled()
    expect(f.dependencies.connect).not.toHaveBeenCalled()
  })

  it.each([0, 2])('refuses ambiguous settings cardinality %i', async (count) => {
    const f = fixture()
    vi.mocked(f.store.readSettings).mockResolvedValue(
      Array.from({ length: count }, (_, i) => ({ id: 'settings-' + i, authConfig: null }))
    )
    await expect(f.run('enable')).rejects.toThrow('exactly one settings row')
    expect(f.dependencies.writeSnapshot).not.toHaveBeenCalled()
    expect(f.store.compareAndSet).not.toHaveBeenCalled()
    expect(f.store.close).toHaveBeenCalledOnce()
  })

  it.each([
    null,
    ' { "openSignup": false, "oauth": { "password": false, "magicLink": false, "custom": true }, "unknown": { "nested": [1, "kept"] } } ',
  ])('restores the exact original column including null and whitespace: %s', async (initial) => {
    const f = fixture(initial)
    await f.run('enable')
    expect(JSON.parse(f.current()!)).toMatchObject({
      openSignup: true,
      oauth: { password: true, magicLink: true },
    })
    await f.run('restore')
    expect(f.current()).toBe(initial)
    expect(f.snapshot()).toBeNull()
    expect(f.store.invalidateCache).toHaveBeenCalledTimes(2)
  })

  it('preserves every unowned setting and provider flag while enabled', async () => {
    const f = fixture(
      JSON.stringify({
        openSignup: false,
        twoFactorRequired: true,
        oauth: { password: false, magicLink: false, google: true, custom: { enabled: true } },
        unknown: { nested: [1, 'retained'] },
      })
    )
    await f.run('enable')
    expect(JSON.parse(f.current()!)).toEqual({
      openSignup: true,
      twoFactorRequired: true,
      oauth: { password: true, magicLink: true, google: true, custom: { enabled: true } },
      unknown: { nested: [1, 'retained'] },
    })
  })

  it('keeps the original snapshot when enable is retried', async () => {
    const f = fixture('{"openSignup":false}')
    await f.run('enable')
    const original = structuredClone(f.snapshot())
    await f.run('enable')
    expect(f.snapshot()).toEqual(original)
    expect(f.dependencies.writeSnapshot).toHaveBeenCalledOnce()
    expect(f.store.compareAndSet).toHaveBeenCalledOnce()
  })

  it('retains the snapshot if enable loses its compare-and-set', async () => {
    const f = fixture()
    vi.mocked(f.store.compareAndSet).mockResolvedValueOnce(false)
    await expect(f.run('enable')).rejects.toThrow('changed before enabling')
    expect(f.current()).toBeNull()
    expect(f.snapshot()).not.toBeNull()
    expect(f.store.invalidateCache).not.toHaveBeenCalled()
    await f.run('enable')
    expect(f.dependencies.writeSnapshot).toHaveBeenCalledOnce()
    expect(JSON.parse(f.current()!).openSignup).toBe(true)
  })

  it.each(['enable', 'restore'])('refuses %s after unrelated settings change', async (action) => {
    const f = fixture()
    await f.run('enable')
    const saved = structuredClone(f.snapshot())
    const foreign = JSON.stringify({ ...JSON.parse(f.current()!), unknown: 'changed elsewhere' })
    f.setCurrent(foreign)
    vi.mocked(f.store.compareAndSet).mockClear()
    vi.mocked(f.store.invalidateCache).mockClear()
    await expect(f.run(action)).rejects.toThrow('changed outside this fixture')
    expect(f.current()).toBe(foreign)
    expect(f.snapshot()).toEqual(saved)
    expect(f.store.compareAndSet).not.toHaveBeenCalled()
    expect(f.store.invalidateCache).not.toHaveBeenCalled()
  })

  it.each(['runId', 'runAttempt'])(
    'rejects a snapshot from another %s before connecting',
    async (key) => {
      const f = fixture()
      await f.run('enable')
      f.setSnapshot({ ...(f.snapshot() as object), [key]: '999' })
      vi.mocked(f.dependencies.connect).mockClear()
      await expect(f.run('restore')).rejects.toThrow('does not belong to this run')
      expect(f.dependencies.connect).not.toHaveBeenCalled()
      expect(f.snapshot()).not.toBeNull()
    }
  )

  it('rejects another settings row without modifying it or consuming the snapshot', async () => {
    const f = fixture()
    await f.run('enable')
    f.setRowId('settings-different')
    vi.mocked(f.store.compareAndSet).mockClear()
    await expect(f.run('restore')).rejects.toThrow('row does not match snapshot')
    expect(f.store.compareAndSet).not.toHaveBeenCalled()
    expect(f.snapshot()).not.toBeNull()
  })

  it.each(['', 'null', '[]', '{"oauth":false}', '{"oauth":null}', '{"oauth":[]}'])(
    'rejects malformed/non-object configuration without mutation: %s',
    async (initial) => {
      const f = fixture(initial)
      await expect(f.run('enable')).rejects.toThrow()
      expect(f.current()).toBe(initial)
      expect(f.dependencies.writeSnapshot).not.toHaveBeenCalled()
      expect(f.store.compareAndSet).not.toHaveBeenCalled()
      expect(f.store.invalidateCache).not.toHaveBeenCalled()
      expect(f.store.close).toHaveBeenCalledOnce()
    }
  )

  it('rejects a snapshot that claims unrelated installed changes', async () => {
    const f = fixture()
    await f.run('enable')
    f.setSnapshot({ ...(f.snapshot() as object), installed: '{"openSignup":true,"unknown":1}' })
    vi.mocked(f.dependencies.connect).mockClear()
    await expect(f.run('restore')).rejects.toThrow('invalid snapshot configuration')
    expect(f.dependencies.connect).not.toHaveBeenCalled()
  })

  it('retries enable cache invalidation without replacing the original snapshot', async () => {
    const f = fixture()
    vi.mocked(f.store.invalidateCache).mockRejectedValueOnce(new Error('cache unavailable'))
    await expect(f.run('enable')).rejects.toThrow('cache unavailable')
    const saved = structuredClone(f.snapshot())
    await f.run('enable')
    expect(f.snapshot()).toEqual(saved)
    expect(f.dependencies.writeSnapshot).toHaveBeenCalledOnce()
    expect(f.store.compareAndSet).toHaveBeenCalledOnce()
  })

  it('safely retries restore after DB success and cache failure', async () => {
    const initial = ' { "openSignup": false, "unowned": "keep" } '
    const f = fixture(initial)
    await f.run('enable')
    const saved = structuredClone(f.snapshot())
    vi.mocked(f.store.invalidateCache).mockRejectedValueOnce(new Error('cache unavailable'))
    await expect(f.run('restore')).rejects.toThrow('cache unavailable')
    expect(f.current()).toBe(initial)
    expect(f.snapshot()).toEqual(saved)
    expect(f.dependencies.removeSnapshot).not.toHaveBeenCalled()
    vi.mocked(f.store.compareAndSet).mockClear()
    await f.run('restore')
    expect(f.store.compareAndSet).not.toHaveBeenCalled()
    expect(f.current()).toBe(initial)
    expect(f.snapshot()).toBeNull()
  })

  it('does not overwrite a change made after a failed restore invalidation', async () => {
    const f = fixture()
    await f.run('enable')
    vi.mocked(f.store.invalidateCache).mockRejectedValueOnce(new Error('cache unavailable'))
    await expect(f.run('restore')).rejects.toThrow('cache unavailable')
    f.setCurrent('{"unowned":"newer"}')
    vi.mocked(f.store.compareAndSet).mockClear()
    await expect(f.run('restore')).rejects.toThrow('changed outside this fixture')
    expect(f.current()).toBe('{"unowned":"newer"}')
    expect(f.store.compareAndSet).not.toHaveBeenCalled()
    expect(f.snapshot()).not.toBeNull()
  })

  it('retries safely if snapshot removal failed after successful restoration', async () => {
    const f = fixture()
    await f.run('enable')
    vi.mocked(f.dependencies.removeSnapshot).mockImplementationOnce(() => {
      throw new Error('file busy')
    })
    await expect(f.run('restore')).rejects.toThrow('file busy')
    expect(f.current()).toBeNull()
    expect(f.snapshot()).not.toBeNull()
    vi.mocked(f.store.compareAndSet).mockClear()
    await f.run('restore')
    expect(f.store.compareAndSet).not.toHaveBeenCalled()
    expect(f.snapshot()).toBeNull()
  })

  it('makes restore without a snapshot an isolated no-op', async () => {
    const f = fixture()
    await f.run('restore')
    expect(f.dependencies.guard).toHaveBeenCalledOnce()
    expect(f.dependencies.connect).not.toHaveBeenCalled()
    expect(f.dependencies.removeSnapshot).not.toHaveBeenCalled()
  })
})
