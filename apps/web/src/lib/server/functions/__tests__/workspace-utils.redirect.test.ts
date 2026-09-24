import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { db } from '@/lib/server/db'

/**
 * `requireWorkspaceRole` guards team routes in `beforeLoad`. When an
 * unauthenticated caller hits a team-only route it must land on the
 * portal sign-in dialog (portal root with `auth=signin`) carrying
 * `callbackUrl=/admin`. Portal-allowed routes still fall back to `/`.
 *
 * The handler is a `createServerFn`, so we stub `createServerFn` to
 * capture the raw handler and invoke it directly — the same pattern the
 * other function-handler tests use.
 */

const hoisted = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  providers: ['github'] as string[],
}))

vi.mock('@/lib/server/auth/session', () => ({ getSession: hoisted.mockGetSession }))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      settings: { findFirst: vi.fn() },
      principal: { findFirst: vi.fn() },
      account: {
        findMany: async () => hoisted.providers.map((providerId) => ({ providerId })),
      },
    },
  },
  principal: {},
  account: { userId: 'account.userId' },
  user: { id: 'user.id' },
  eq: vi.fn(),
}))

vi.mock('@/lib/server/logger', () => ({
  logger: { child: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}))

type AnyHandler = (args: { data: { allowedRoles: string[] } }) => Promise<unknown>

const handlers: AnyHandler[] = []
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: AnyHandler) {
        handlers.push(fn)
        return chain
      },
    }
    return chain
  },
}))

type RedirectErr = {
  to?: string
  search?: { callbackUrl?: string; auth?: string; error?: string }
  options?: { to?: string; search?: { callbackUrl?: string; auth?: string; error?: string } }
}

let requireWorkspaceRole: AnyHandler

/** A signed-in session for a verified team-domain account. */
const teamSession = (id: string) => ({
  user: { id, email: `${id}@acme.example`, emailVerified: true },
})

const savedDomains = process.env.VENTURI_TEAM_EMAIL_DOMAINS

beforeEach(async () => {
  vi.clearAllMocks()
  hoisted.providers = ['github']
  process.env.VENTURI_TEAM_EMAIL_DOMAINS = 'acme.example'
  if (handlers.length === 0) await import('../workspace-utils')
  requireWorkspaceRole = handlers[0]
})

afterEach(() => {
  if (savedDomains === undefined) delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  else process.env.VENTURI_TEAM_EMAIL_DOMAINS = savedDomains
})

describe('requireWorkspaceRole redirect target', () => {
  it('sends unauthenticated team-only callers to the sign-in dialog with callbackUrl=/admin', async () => {
    hoisted.mockGetSession.mockResolvedValue(null)

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
      .then(() => null)
      .catch((e) => e as RedirectErr)

    expect(err?.to ?? err?.options?.to).toBe('/')
    const search = err?.search ?? err?.options?.search
    expect(search?.auth).toBe('signin')
    expect(search?.callbackUrl).toBe('/admin')
  })

  it('leaves portal-allowed (non-team) callers on /', async () => {
    hoisted.mockGetSession.mockResolvedValue(null)

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'user'] } })
      .then(() => null)
      .catch((e) => e as { to?: string; options?: { to?: string } })

    expect(err?.to ?? err?.options?.to).toBe('/')
  })

  it('redirects wrong-role callers to sign-in dialog with not_team_member error', async () => {
    hoisted.mockGetSession.mockResolvedValue(teamSession('user_001'))
    ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 })
    ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ role: 'user' })

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
      .then(() => null)
      .catch((e) => e as RedirectErr)

    expect(err?.to ?? err?.options?.to).toBe('/')
    const search = err?.search ?? err?.options?.search
    expect(search?.auth).toBe('signin')
    expect(search?.callbackUrl).toBe('/admin')
    expect(search?.error).toBe('not_team_member')
  })

  it('redirects an anonymous principal that carries a stored admin role (team role cap)', async () => {
    hoisted.mockGetSession.mockResolvedValue(teamSession('user_anon'))
    ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 })
    ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      role: 'admin',
      type: 'anonymous',
    })

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
      .then(() => null)
      .catch((e) => e as RedirectErr)

    const search = err?.search ?? err?.options?.search
    expect(search?.error).toBe('not_team_member')
  })

  it('sends a team member on an administrator-only route to the durable settings notice', async () => {
    hoisted.mockGetSession.mockResolvedValue(teamSession('user_member'))
    ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 })
    ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      role: 'member',
      type: 'user',
    })

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin'] } })
      .then(() => null)
      .catch((e) => e as RedirectErr)

    expect(err?.to ?? err?.options?.to).toBe('/admin/settings')
    const search = err?.search ?? err?.options?.search
    expect(search?.error).toBe('not_admin')
    // Never the portal sign-in dialog: the member is already signed in.
    expect(search?.auth).toBeUndefined()
  })

  it('still sends a portal user on an administrator-only route to sign-in with not_team_member', async () => {
    hoisted.mockGetSession.mockResolvedValue(teamSession('user_portal'))
    ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 })
    ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      role: 'user',
      type: 'user',
    })

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin'] } })
      .then(() => null)
      .catch((e) => e as RedirectErr)

    const search = err?.search ?? err?.options?.search
    expect(search?.error).toBe('not_team_member')
    expect(search?.auth).toBe('signin')
  })

  it.each(['user', 'member', 'admin'])(
    'does not expose raw settings when a %s caller supplies its own allowed role',
    async (role) => {
      hoisted.mockGetSession.mockResolvedValue(teamSession('user_001'))
      ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        widgetSecret: 'private-signing-secret',
        portalConfig: '{"access":{"allowedEmails":["private@acme.example"]}}',
      })
      ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'principal_001',
        role,
        type: 'user',
      })

      const result = await requireWorkspaceRole({ data: { allowedRoles: [role] } })
      expect(result).not.toHaveProperty('settings')
      expect(JSON.stringify(result)).not.toContain('private-signing-secret')
      expect(JSON.stringify(result)).not.toContain('private@acme.example')
      expect(db.query.settings.findFirst).toHaveBeenCalledWith({ columns: { id: true } })
    }
  )

  it('lets a human admin through with its role intact', async () => {
    hoisted.mockGetSession.mockResolvedValue(teamSession('user_admin'))
    ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 })
    ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      role: 'admin',
      type: 'user',
    })

    const result = (await requireWorkspaceRole({
      data: { allowedRoles: ['admin', 'member'] },
    })) as {
      principal: { role: string }
    }
    expect(result.principal.role).toBe('admin')
  })

  it('sends a stored admin whose identity fails the team rule to sign-in with the reason', async () => {
    hoisted.providers = ['credential']
    hoisted.mockGetSession.mockResolvedValue(teamSession('user_bootstrap'))
    ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 })
    ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'principal_bootstrap',
      role: 'admin',
      type: 'user',
      userId: 'user_bootstrap',
    })

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
      .then(() => null)
      .catch((e) => e as RedirectErr)

    const search = err?.search ?? err?.options?.search
    expect(search?.auth).toBe('signin')
    expect(search?.error).toBe('team_identity_required')
  })

  it('refuses a stored admin at an address outside the team domains', async () => {
    hoisted.mockGetSession.mockResolvedValue({
      user: { id: 'user_x', email: 'x@gmail.com', emailVerified: true },
    })
    ;(db.query.settings.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 })
    ;(db.query.principal.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'principal_x',
      role: 'admin',
      type: 'user',
      userId: 'user_x',
    })

    const err = await requireWorkspaceRole({ data: { allowedRoles: ['admin'] } })
      .then(() => null)
      .catch((e) => e as RedirectErr)

    expect((err?.search ?? err?.options?.search)?.error).toBe('team_identity_required')
  })
})
