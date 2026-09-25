// @vitest-environment node
/**
 * DEF-62 (landing-page#2309): the unlink gate ends the request.
 *
 * handleUnlinkAccountGate performs every Google or GitHub unlink itself, under
 * the team-role lock, and hooksBefore returns its response body. That only
 * holds if Better Auth treats a before-hook response as the answer and never
 * runs its own /unlink-account handler afterwards, whose delete would run
 * outside the lock. These cases prove it through a real Better Auth instance,
 * its HTTP router and auth.api, rather than by reading its dispatcher.
 *
 * The gate's transaction is a stand-in that reads and deletes the same
 * in-memory rows Better Auth uses, and Better Auth's own account deletes are
 * counted by a database hook. The lock itself is covered on PostgreSQL in
 * unlink-account-lock-db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { makeSignature } from 'better-auth/crypto'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => {
  const state = {
    store: {} as Record<string, Row[]>,
    principal: undefined as undefined | { id: string; role: string; type: string },
    otherAdmins: 0,
    lockCount: 0,
    /** Account ids the gate deleted inside its transaction. */
    gateDeletes: [] as unknown[],
    /** Account ids Better Auth's own handler deleted. */
    betterAuthDeletes: [] as unknown[],
    tx: undefined as unknown,
  }
  state.tx = {
    query: {
      account: {
        findMany: async ({ where }: { where: { val: unknown } }) =>
          (state.store.account ?? [])
            .filter((row) => row.userId === where.val)
            .map(({ id, providerId, accountId }) => ({ id, providerId, accountId })),
      },
      principal: { findFirst: async () => state.principal },
    },
    delete: () => ({
      where: async ({ val }: { val: unknown }) => {
        state.gateDeletes.push(val)
        state.store.account = (state.store.account ?? []).filter((row) => row.id !== val)
      },
    }),
  }
  return state
})

vi.mock('@/lib/server/domains/principals/team-designation', () => ({
  withTeamRoleLock: async <T>(fn: (tx: unknown) => Promise<T>) => {
    hoisted.lockCount += 1
    return fn(hoisted.tx)
  },
  countEligibleAdmins: async () => hoisted.otherAdmins,
}))

vi.mock('@/lib/server/db', () => ({
  db: {},
  principal: { userId: 'principal.userId' },
  account: { userId: 'account.userId', id: 'account.id' },
  eq: (col: string, val: unknown) => ({ col, val }),
}))

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
}))

const { hooksBefore } = await import('../hooks')

const ORIGIN = 'https://qb.example'
const UNLINK_URL = `${ORIGIN}/api/auth/unlink-account`

/** A Better Auth instance with the app's before hook, over a fresh in-memory store. */
function createTestAuth() {
  hoisted.store = { user: [], session: [], account: [], verification: [] }
  return betterAuth({
    baseURL: ORIGIN,
    secret: 'unlink-account-dispatch-test-secret-0123456789abcdef',
    database: memoryAdapter(hoisted.store),
    telemetry: { enabled: false },
    // Better Auth skips its origin check under a test runner; keep it on, as in production.
    advanced: { disableOriginCheck: false },
    hooks: { before: hooksBefore },
    databaseHooks: {
      account: {
        delete: {
          before: async (account) => {
            hoisted.betterAuthDeletes.push(account.id)
          },
        },
      },
    },
  })
}

type TestAuth = ReturnType<typeof createTestAuth>

/** A signed-in person with the given links; returns the session cookie. */
async function signedInWith(
  auth: TestAuth,
  links: Array<{ providerId: string; accountId: string }>
): Promise<string> {
  const ctx = await auth.$context
  const user = await ctx.internalAdapter.createUser({
    name: 'Ada',
    email: 'ada@acme.example',
    emailVerified: true,
  })
  for (const link of links) {
    await ctx.internalAdapter.createAccount({ userId: user.id, ...link })
  }
  const session = await ctx.internalAdapter.createSession(user.id)
  const signature = await makeSignature(session.token, ctx.secret)
  return `${ctx.authCookies.sessionToken.name}=${session.token}.${signature}`
}

function unlinkRequest(auth: TestAuth, cookie: string, body: Row, origin = ORIGIN) {
  return auth.handler(
    new Request(UNLINK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify(body),
    })
  )
}

/** The accountId of every remaining link of a provider, in insertion order. */
function remaining(providerId: string): unknown[] {
  return (hoisted.store.account ?? [])
    .filter((row) => row.providerId === providerId)
    .map((row) => row.accountId)
}

const twoGithubLinks = [
  { providerId: 'github', accountId: 'gh_1' },
  { providerId: 'github', accountId: 'gh_2' },
]

beforeEach(() => {
  hoisted.principal = { id: 'principal_ada', role: 'user', type: 'user' }
  hoisted.otherAdmins = 0
  hoisted.lockCount = 0
  hoisted.gateDeletes = []
  hoisted.betterAuthDeletes = []
})

describe('a Google or GitHub unlink through Better Auth', () => {
  it('is answered by the before hook, with exactly one delete (router)', async () => {
    const auth = createTestAuth()
    const cookie = await signedInWith(auth, twoGithubLinks)

    const res = await unlinkRequest(auth, cookie, { providerId: 'github' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: true })
    expect(hoisted.lockCount).toBe(1)
    expect(hoisted.gateDeletes).toHaveLength(1)
    // Better Auth's handler would have removed the second link too.
    expect(hoisted.betterAuthDeletes).toEqual([])
    expect(remaining('github')).toEqual(['gh_2'])
  })

  it('is answered by the before hook, with exactly one delete (auth.api)', async () => {
    const auth = createTestAuth()
    const cookie = await signedInWith(auth, twoGithubLinks)

    const result = await auth.api.unlinkAccount({
      body: { providerId: 'github' },
      headers: new Headers({ cookie }),
    })

    expect(result).toEqual({ status: true })
    expect(hoisted.gateDeletes).toHaveLength(1)
    expect(hoisted.betterAuthDeletes).toEqual([])
    expect(remaining('github')).toEqual(['gh_2'])
  })

  it('treats an empty accountId as absent, as Better Auth does', async () => {
    const auth = createTestAuth()
    const cookie = await signedInWith(auth, twoGithubLinks)

    const res = await unlinkRequest(auth, cookie, { providerId: 'github', accountId: '' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: true })
    expect(hoisted.gateDeletes).toHaveLength(1)
    expect(hoisted.betterAuthDeletes).toEqual([])
    expect(remaining('github')).toEqual(['gh_2'])
  })

  it('returns the gate’s refusal and deletes nothing', async () => {
    hoisted.principal = { id: 'principal_ada', role: 'admin', type: 'user' }
    const auth = createTestAuth()
    const cookie = await signedInWith(auth, [
      { providerId: 'github', accountId: 'gh_1' },
      { providerId: 'credential', accountId: 'ada' },
    ])

    const res = await unlinkRequest(auth, cookie, { providerId: 'github' })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'last_admin_identity' })
    expect(hoisted.gateDeletes).toEqual([])
    expect(hoisted.betterAuthDeletes).toEqual([])
    expect(remaining('github')).toEqual(['gh_1'])
  })

  it('is refused by the router’s origin check before the gate runs', async () => {
    const auth = createTestAuth()
    const cookie = await signedInWith(auth, twoGithubLinks)

    const res = await unlinkRequest(auth, cookie, { providerId: 'github' }, 'https://evil.example')

    expect(res.status).toBe(403)
    expect(hoisted.lockCount).toBe(0)
    expect(hoisted.gateDeletes).toEqual([])
    expect(hoisted.betterAuthDeletes).toEqual([])
    expect(remaining('github')).toEqual(['gh_1', 'gh_2'])
  })
})

describe('an unlink of any other provider', () => {
  it('reaches Better Auth’s own handler, whose deletes this suite counts', async () => {
    const auth = createTestAuth()
    const cookie = await signedInWith(auth, [
      { providerId: 'gitlab', accountId: 'gl_1' },
      { providerId: 'github', accountId: 'gh_1' },
    ])

    const res = await unlinkRequest(auth, cookie, { providerId: 'gitlab' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: true })
    expect(hoisted.lockCount).toBe(0)
    expect(hoisted.gateDeletes).toEqual([])
    expect(hoisted.betterAuthDeletes).toHaveLength(1)
    expect(remaining('gitlab')).toEqual([])
    expect(remaining('github')).toEqual(['gh_1'])
  })
})
