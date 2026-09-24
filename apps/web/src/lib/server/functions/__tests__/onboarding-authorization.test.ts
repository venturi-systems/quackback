/**
 * Onboarding authorization contract (feedback portal E-2 / E-3).
 *
 * Covers the five caller shapes the portal sees: a cookie-less caller, an
 * anonymous Better Auth session, a portal user, a team member and an admin.
 *
 *   - listBoardsForOnboarding lists EVERY board (protected ones included), so
 *     only a human admin may read it; everyone else gets an empty shape.
 *   - saveUseCaseFn / setupWorkspaceFn may promote the caller to admin only
 *     while no human admin exists, never for an anonymous principal, and never
 *     because `setup_state` is NULL or partial on a live workspace.
 *   - checkOnboardingState resolves the caller from the session (it accepts no
 *     client-supplied user id) and never writes.
 *
 * The principal/user tables are an in-memory store driven through the same
 * drizzle operator shapes the code uses, so the real requireAuth and the real
 * bootstrap-claim transaction run against it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, unknown>
type Cond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'and'; conds: Cond[] }
  | { op: 'sql'; text: string }

const store = vi.hoisted(() => ({
  principals: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
  accounts: [] as Array<Record<string, unknown>>,
  settingsWrites: [] as Array<Record<string, unknown>>,
  settingsInserts: [] as Array<Record<string, unknown>>,
  settingsRow: null as Record<string, unknown> | null,
  session: null as null | {
    user: { id: string; principalType: string; email?: string; emailVerified?: boolean }
  },
  authSession: null as null | {
    user: { id: string; email: string; name: string; emailVerified?: boolean }
  },
  lockCalls: 0,
}))

// Column markers: drizzle columns become 'table.column' strings.
const col = (table: string) =>
  new Proxy({}, { get: (_t, key) => `${table}.${String(key)}` }) as Record<string, string>

function matches(row: Row, table: string, cond: Cond | undefined): boolean {
  if (!cond) return true
  if (cond.op === 'and') return cond.conds.every((c) => matches(row, table, c))
  if (cond.op === 'eq') {
    const [t, field] = cond.col.split('.')
    if (t !== table) return false
    return row[field] === cond.val
  }
  return true
}

function tableRows(table: string): Row[] {
  if (table === 'principal') return store.principals
  if (table === 'user') return store.users
  if (table === 'account') return store.accounts
  return []
}

function makeDb() {
  const query = {
    principal: {
      findFirst: async ({ where }: { where?: Cond } = {}) =>
        store.principals.find((r) => matches(r, 'principal', where)),
    },
    user: {
      findFirst: async ({ where }: { where?: Cond } = {}) =>
        store.users.find((r) => matches(r, 'user', where)),
    },
    account: {
      findMany: async ({ where }: { where?: Cond } = {}) =>
        store.accounts.filter((r) => matches(r, 'account', where)),
    },
    postStatuses: { findFirst: async () => ({ id: 'status_1' }) },
  }
  const tableName = (t: Record<string, string>) => String(t.id).split('.')[0]
  const api = {
    query,
    execute: async (q: Cond) => {
      if (q?.op === 'sql' && q.text.includes('pg_advisory_xact_lock')) store.lockCalls += 1
    },
    insert: (t: Record<string, string>) => ({
      values: async (v: Row) => {
        const name = tableName(t)
        if (name === 'principal') store.principals.push({ ...v })
        else if (name === 'settings') store.settingsInserts.push({ ...v })
        return [v]
      },
    }),
    update: (t: Record<string, string>) => ({
      set: (v: Row) => ({
        // Mutates immediately; the result is awaitable and supports
        // .returning() like a drizzle update builder.
        where: (cond: Cond) => {
          const name = tableName(t)
          if (name === 'settings') {
            store.settingsWrites.push({ ...v })
          } else {
            for (const r of tableRows(name)) if (matches(r, name, cond)) Object.assign(r, v)
          }
          return {
            returning: async () => [{ ...(store.settingsRow ?? {}), ...v }],
            then: (resolve: (value: undefined) => void) => resolve(undefined),
          }
        },
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(api),
  }
  return api
}

vi.mock('@tanstack/react-start', () => ({
  // The exported server fn IS the raw handler, so tests call it directly.
  createServerFn: () => {
    const chain = {
      validator: () => chain,
      handler: (fn: unknown) => fn,
    }
    return chain
  },
  createServerOnlyFn: <T>(fn: T) => fn,
}))

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers({ cookie: 'better-auth.session_token=x' }),
}))

vi.mock('@/lib/server/db', () => {
  const db = makeDb()
  return {
    db,
    settings: col('settings'),
    principal: col('principal'),
    user: col('user'),
    account: col('account'),
    postStatuses: col('postStatuses'),
    eq: (c: string, val: unknown) => ({ op: 'eq', col: c, val }),
    and: (...conds: Cond[]) => ({ op: 'and', conds }),
    sql: (strings: TemplateStringsArray) => ({ op: 'sql', text: strings.join('') }),
    DEFAULT_STATUSES: [],
    USE_CASE_TYPES: ['saas', 'consumer', 'marketplace', 'internal'],
  }
})

vi.mock('@/lib/server/auth/session', () => ({
  getSession: async () => store.session,
}))

// requireAuth (auth-helpers) reads the Better Auth session directly.
vi.mock('@/lib/server/auth', () => ({
  auth: { api: { getSession: async () => store.authSession } },
}))

vi.mock('@/lib/server/functions/workspace', () => ({
  getSettings: async () => store.settingsRow,
}))

vi.mock('@/lib/server/domains/principals/principal.service', () => ({
  syncPrincipalProfile: vi.fn(),
}))
vi.mock('@/lib/server/domains/boards/board.service', () => ({
  listBoards: async () => [
    { id: 'board_public', name: 'Feature Requests', description: 'Public board' },
    { id: 'board_protected', name: 'Bug Reports', description: 'Protected board' },
  ],
}))
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: async () => ({ maxBoards: 10 }),
}))
vi.mock('@/lib/server/domains/settings/settings.helpers', () => ({
  invalidateSettingsCache: vi.fn(),
}))
vi.mock('@/lib/server/domains/settings', () => ({
  DEFAULT_AUTH_CONFIG: { oauth: {}, openSignup: false },
  DEFAULT_PORTAL_CONFIG: { features: {} },
}))
vi.mock('@/lib/server/config-file/managed-guard', () => ({
  assertNotManaged: vi.fn(async () => undefined),
}))
vi.mock('@/lib/server/config-file/managed-paths', () => ({
  isPathManaged: () => false,
}))
vi.mock('@/lib/server/domains/segments/segment-membership.service', () => ({
  segmentIdsForPrincipal: vi.fn(async () => new Set()),
}))

const onboarding = await import('../onboarding')
type Handler<A = unknown, R = unknown> = (args: A) => Promise<R>
const listBoardsForOnboarding = onboarding.listBoardsForOnboarding as unknown as Handler<
  void,
  { boards: Array<{ id: string }>; maxBoards: number | null }
>
const saveUseCaseFn = onboarding.saveUseCaseFn as unknown as Handler<{
  data: { useCase: string }
}>
const setupWorkspaceFn = onboarding.setupWorkspaceFn as unknown as Handler<{
  data: { workspaceName: string }
}>
const checkOnboardingState = onboarding.checkOnboardingState as unknown as Handler<
  void,
  {
    needsInvitation?: boolean
    principalRecord: { role: string } | null
    setupState: unknown
    isOnboardingComplete: boolean
  }
>
const { ONBOARDING_DENIED } = onboarding

const COMPLETE = JSON.stringify({
  version: 1,
  steps: { core: true, workspace: true, boards: true },
  useCase: 'saas',
})
const WORKSPACE_PENDING = JSON.stringify({
  version: 1,
  steps: { core: true, workspace: false, boards: false },
})
const BOARDS_PENDING = JSON.stringify({
  version: 1,
  steps: { core: true, workspace: true, boards: false },
  useCase: 'saas',
})

type Persona = 'cookieless' | 'anonymous' | 'portalUser' | 'member' | 'admin'

const PERSONAS: Record<
  Exclude<Persona, 'cookieless'>,
  { id: string; role: string; type: string }
> = {
  anonymous: { id: 'user_anon', role: 'user', type: 'anonymous' },
  portalUser: { id: 'user_portal', role: 'user', type: 'user' },
  member: { id: 'user_member', role: 'member', type: 'user' },
  admin: { id: 'user_admin', role: 'admin', type: 'user' },
}

/**
 * Seed a person. Human personas carry a verified team-domain address and a
 * GitHub link, so they satisfy the team identity rule unless a test says not.
 */
function seedPrincipal(id: string, role: string, type: string) {
  store.principals.push({ id: `principal_${id}`, userId: id, role, type })
  seedUser(id, type === 'anonymous')
}

function seedUser(id: string, isAnonymous = false, providers: string[] = ['github']) {
  store.users.push({
    id,
    isAnonymous,
    email: `${id}@acme.example`,
    emailVerified: !isAnonymous,
  })
  if (!isAnonymous)
    for (const providerId of providers) store.accounts.push({ userId: id, providerId })
}

function actAs(persona: Persona) {
  if (persona === 'cookieless') {
    store.session = null
    store.authSession = null
    return
  }
  const p = PERSONAS[persona]
  const email = `${p.id}@acme.example`
  const emailVerified = p.type !== 'anonymous'
  store.session = { user: { id: p.id, principalType: p.type, email, emailVerified } }
  store.authSession = { user: { id: p.id, email, name: p.id, emailVerified } }
}

const roleOf = (userId: string) => store.principals.find((r) => r.userId === userId)?.role

const savedDomains = process.env.VENTURI_TEAM_EMAIL_DOMAINS
afterEach(() => {
  if (savedDomains === undefined) delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  else process.env.VENTURI_TEAM_EMAIL_DOMAINS = savedDomains
})

beforeEach(() => {
  process.env.VENTURI_TEAM_EMAIL_DOMAINS = 'acme.example'
  store.principals.length = 0
  store.users.length = 0
  store.accounts.length = 0
  store.settingsWrites.length = 0
  store.settingsInserts.length = 0
  store.settingsRow = { id: 'workspace_1', slug: 'venturi', name: 'Venturi', setupState: COMPLETE }
  store.lockCalls = 0
  for (const p of Object.values(PERSONAS)) seedPrincipal(p.id, p.role, p.type)
})

describe('listBoardsForOnboarding: board enumeration', () => {
  it.each<Persona>(['cookieless', 'anonymous', 'portalUser', 'member'])(
    'returns no boards to a %s caller',
    async (persona) => {
      actAs(persona)
      const result = await listBoardsForOnboarding()
      expect(result).toEqual({ boards: [], maxBoards: null })
    }
  )

  it('returns no boards to an anonymous principal that carries a stored admin role', async () => {
    const anon = store.principals.find((r) => r.userId === 'user_anon')!
    anon.role = 'admin'
    actAs('anonymous')
    const result = await listBoardsForOnboarding()
    expect(result.boards).toEqual([])
  })

  it('returns every board to a human admin', async () => {
    actAs('admin')
    const result = await listBoardsForOnboarding()
    expect(result.boards.map((b) => b.id)).toEqual(['board_public', 'board_protected'])
    expect(result.maxBoards).toBe(10)
  })
})

describe('saveUseCaseFn: no promotion outside the bootstrap window', () => {
  it('rejects a cookie-less caller', async () => {
    actAs('cookieless')
    await expect(saveUseCaseFn({ data: { useCase: 'saas' } })).rejects.toThrow(
      'Authentication required'
    )
    expect(store.settingsWrites).toEqual([])
  })

  it.each([
    ['NULL setup_state', null],
    ['workspace step not done', WORKSPACE_PENDING],
  ])('refuses an anonymous session with %s and never promotes it', async (_label, state) => {
    store.settingsRow!.setupState = state
    actAs('anonymous')
    await expect(saveUseCaseFn({ data: { useCase: 'saas' } })).rejects.toThrow(
      ONBOARDING_DENIED.anonymous
    )
    expect(roleOf('user_anon')).toBe('user')
    expect(store.settingsWrites).toEqual([])
  })

  it.each([
    ['NULL setup_state', null],
    ['workspace step not done', WORKSPACE_PENDING],
  ])(
    'refuses a portal user with %s while a human admin exists, without writing',
    async (_label, state) => {
      store.settingsRow!.setupState = state
      actAs('portalUser')
      await expect(saveUseCaseFn({ data: { useCase: 'saas' } })).rejects.toThrow(
        ONBOARDING_DENIED.notAdmin
      )
      expect(roleOf('user_portal')).toBe('user')
      expect(store.settingsWrites).toEqual([])
      expect(store.lockCalls).toBe(1)
    }
  )

  it('refuses a team member the same way (members are not promoted to admin)', async () => {
    store.settingsRow!.setupState = null
    actAs('member')
    await expect(saveUseCaseFn({ data: { useCase: 'saas' } })).rejects.toThrow(
      ONBOARDING_DENIED.notAdmin
    )
    expect(roleOf('user_member')).toBe('member')
  })

  it.each<Persona>(['anonymous', 'portalUser', 'member', 'admin'])(
    'refuses %s on a completed workspace (no re-onboarding write)',
    async (persona) => {
      actAs(persona)
      await expect(saveUseCaseFn({ data: { useCase: 'internal' } })).rejects.toThrow()
      expect(store.settingsWrites).toEqual([])
    }
  )

  it('lets only the admin change the use case once the workspace step is done', async () => {
    store.settingsRow!.setupState = BOARDS_PENDING
    actAs('portalUser')
    await expect(saveUseCaseFn({ data: { useCase: 'internal' } })).rejects.toThrow(
      ONBOARDING_DENIED.notAdmin
    )
    expect(store.settingsWrites).toEqual([])

    actAs('admin')
    await saveUseCaseFn({ data: { useCase: 'internal' } })
    expect(store.settingsWrites).toHaveLength(1)
    expect(JSON.parse(String(store.settingsWrites[0].setupState)).useCase).toBe('internal')
  })

  it('promotes the first human user on a workspace with no human admin (bootstrap)', async () => {
    store.principals.splice(
      store.principals.findIndex((r) => r.userId === 'user_admin'),
      1
    )
    store.settingsRow!.setupState = WORKSPACE_PENDING
    actAs('portalUser')
    await saveUseCaseFn({ data: { useCase: 'saas' } })
    expect(roleOf('user_portal')).toBe('admin')
    expect(store.settingsWrites).toHaveLength(1)
  })

  it('never promotes an anonymous session even when no human admin exists', async () => {
    store.principals.splice(
      store.principals.findIndex((r) => r.userId === 'user_admin'),
      1
    )
    store.settingsRow = null
    actAs('anonymous')
    await expect(saveUseCaseFn({ data: { useCase: 'saas' } })).rejects.toThrow(
      ONBOARDING_DENIED.anonymous
    )
    expect(roleOf('user_anon')).toBe('user')
    expect(store.settingsInserts).toEqual([])
  })

  it('refuses a human-typed session whose user row is anonymous and has no principal', async () => {
    store.principals.length = 0
    store.users.push({ id: 'user_ghost', isAnonymous: true })
    store.settingsRow = null
    store.session = { user: { id: 'user_ghost', principalType: 'user' } }
    await expect(saveUseCaseFn({ data: { useCase: 'saas' } })).rejects.toThrow(
      ONBOARDING_DENIED.anonymous
    )
    expect(store.principals).toEqual([])
    expect(store.settingsInserts).toEqual([])
  })

  it('refuses the bootstrap claim for an identity that fails the team identity rule', async () => {
    store.principals.length = 0
    store.users.length = 0
    store.accounts.length = 0
    // A password-only account at the team domain: no Google or GitHub link.
    seedUser('user_first', false, ['credential'])
    store.settingsRow = null
    store.session = {
      user: {
        id: 'user_first',
        principalType: 'user',
        email: 'user_first@acme.example',
        emailVerified: true,
      },
    }
    await expect(saveUseCaseFn({ data: { useCase: 'saas' } })).rejects.toMatchObject({
      code: 'TEAM_IDENTITY_REQUIRED',
    })
    expect(store.principals).toEqual([])
    expect(store.settingsInserts).toEqual([])
  })

  it('creates settings on a fresh install only after the caller claimed admin', async () => {
    store.principals.length = 0
    store.users.length = 0
    store.accounts.length = 0
    seedUser('user_first')
    store.settingsRow = null
    store.session = {
      user: {
        id: 'user_first',
        principalType: 'user',
        email: 'user_first@acme.example',
        emailVerified: true,
      },
    }
    await saveUseCaseFn({ data: { useCase: 'saas' } })
    expect(store.principals).toEqual([
      expect.objectContaining({ userId: 'user_first', role: 'admin', type: 'user' }),
    ])
    expect(store.settingsInserts).toHaveLength(1)
  })
})

describe('setupWorkspaceFn: no promotion outside the bootstrap window', () => {
  it('refuses an anonymous session before any write', async () => {
    store.settingsRow!.setupState = WORKSPACE_PENDING
    actAs('anonymous')
    await expect(setupWorkspaceFn({ data: { workspaceName: 'Venturi' } })).rejects.toThrow(
      ONBOARDING_DENIED.anonymous
    )
    expect(roleOf('user_anon')).toBe('user')
    expect(store.settingsWrites).toEqual([])
  })

  it.each([
    ['NULL setup_state', null],
    ['workspace step not done', WORKSPACE_PENDING],
  ])('refuses a portal user with %s while a human admin exists', async (_label, state) => {
    store.settingsRow!.setupState = state
    actAs('portalUser')
    await expect(setupWorkspaceFn({ data: { workspaceName: 'Venturi' } })).rejects.toThrow(
      ONBOARDING_DENIED.notAdmin
    )
    expect(roleOf('user_portal')).toBe('user')
    expect(store.settingsWrites).toEqual([])
  })

  it('refuses a non-admin once the workspace step is done', async () => {
    store.settingsRow!.setupState = BOARDS_PENDING
    actAs('member')
    await expect(setupWorkspaceFn({ data: { workspaceName: 'Venturi' } })).rejects.toThrow(
      ONBOARDING_DENIED.notAdmin
    )
  })

  it('refuses everyone, admin included, on a completed workspace', async () => {
    actAs('admin')
    await expect(setupWorkspaceFn({ data: { workspaceName: 'Venturi' } })).rejects.toThrow(
      ONBOARDING_DENIED.complete
    )
    expect(store.settingsWrites).toEqual([])
  })

  it('lets the existing admin finish the workspace step', async () => {
    store.settingsRow!.setupState = WORKSPACE_PENDING
    actAs('admin')
    await setupWorkspaceFn({ data: { workspaceName: 'Venturi' } })
    expect(store.settingsWrites).toHaveLength(1)
    expect(roleOf('user_admin')).toBe('admin')
  })
})

describe('checkOnboardingState: caller from the session, no writes', () => {
  it('reports an empty state to a cookie-less caller', async () => {
    actAs('cookieless')
    const state = await checkOnboardingState()
    expect(state.principalRecord).toBeNull()
    expect(state.needsInvitation).toBeUndefined()
  })

  it('treats an anonymous session as needing an invitation', async () => {
    actAs('anonymous')
    const state = await checkOnboardingState()
    expect(state.needsInvitation).toBe(true)
    expect(state.principalRecord).toBeNull()
  })

  it.each<Persona>(['portalUser', 'member'])(
    'treats a %s as needing an invitation while a human admin exists',
    async (persona) => {
      actAs(persona)
      const state = await checkOnboardingState()
      expect(state.needsInvitation).toBe(true)
    }
  )

  it('returns the admin its own record and the setup state', async () => {
    actAs('admin')
    const state = await checkOnboardingState()
    expect(state.needsInvitation).toBe(false)
    expect(state.principalRecord?.role).toBe('admin')
    expect(state.isOnboardingComplete).toBe(true)
  })

  it('never creates an admin principal for a user without one (the GET is read-only)', async () => {
    store.principals.length = 0
    store.users.push({ id: 'user_first', isAnonymous: false })
    store.session = { user: { id: 'user_first', principalType: 'user' } }
    const state = await checkOnboardingState()
    expect(state.needsInvitation).toBe(false)
    expect(state.principalRecord).toBeNull()
    expect(store.principals).toEqual([])
  })

  it('ignores any client-supplied user id', async () => {
    actAs('portalUser')
    const state = await (
      checkOnboardingState as unknown as Handler<{ data: string }, { needsInvitation?: boolean }>
    )({ data: 'user_admin' })
    expect(state.needsInvitation).toBe(true)
  })
})
