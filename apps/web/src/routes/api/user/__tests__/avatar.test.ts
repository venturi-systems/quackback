/**
 * GET /api/user/avatar/:userId (remediation ledger DEF-10, landing-page#2309).
 *
 * An avatar looked up by user id is identity data: only the account itself or
 * a team member (under the team identity rule) may read it. Everyone else gets
 * the same 404 an unknown id gets, so the route is no open lookup and no
 * existence oracle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateId } from '@quackback/ids'

const getSession = vi.fn()
vi.mock('@/lib/server/auth', () => ({
  auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } },
}))

const principalFindFirst = vi.fn()
const userFindFirst = vi.fn()
vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: { findFirst: (...a: unknown[]) => principalFindFirst(...a) },
      user: { findFirst: (...a: unknown[]) => userFindFirst(...a) },
    },
  },
  principal: { userId: 'principal.userId' },
  user: { id: 'user.id' },
  eq: vi.fn(),
}))

// The role rule itself is session-role.ts (session-role.test.ts); here the
// resolved role is whatever the test says it is.
const resolveSessionRole = vi.fn()
vi.mock('@/lib/server/domains/principals/session-role', () => ({
  resolveSessionRole: (...a: unknown[]) => resolveSessionRole(...a),
}))

vi.mock('@/lib/server/storage/s3', () => ({
  getPublicUrlOrNull: (key: string) => `https://cdn.example.com/${key}`,
}))

const { handleUserAvatar } = await import('../avatar.$userId')

const TARGET = generateId('user')
const OTHER = generateId('user')

const call = (userId: string = TARGET) =>
  handleUserAvatar({
    request: new Request(`http://localhost/api/user/avatar/${userId}`),
    params: { userId },
  })

beforeEach(() => {
  vi.clearAllMocks()
  getSession.mockResolvedValue(null)
  principalFindFirst.mockResolvedValue({
    id: 'principal_1',
    userId: OTHER,
    role: 'user',
    type: 'user',
  })
  resolveSessionRole.mockResolvedValue('user')
  userFindFirst.mockResolvedValue({ imageKey: 'avatars/a.png', image: null })
})

describe('GET /api/user/avatar/:userId', () => {
  it('answers 400 for an id that is not a user TypeID', async () => {
    const res = await call('not-a-user-id')
    expect(res.status).toBe(400)
    expect(userFindFirst).not.toHaveBeenCalled()
  })

  it('answers 404 to an anonymous caller without reading the account', async () => {
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'User not found' })
    expect(userFindFirst).not.toHaveBeenCalled()
  })

  it("answers 404 to a contributor asking for someone else's avatar", async () => {
    getSession.mockResolvedValue({ user: { id: OTHER, email: 'c@example.com' } })
    resolveSessionRole.mockResolvedValue('user')
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'User not found' })
    expect(userFindFirst).not.toHaveBeenCalled()
  })

  it('answers 404 to a stored team role the team identity rule does not accept', async () => {
    getSession.mockResolvedValue({ user: { id: OTHER, email: 'bootstrap@example.com' } })
    principalFindFirst.mockResolvedValue({
      id: 'principal_1',
      userId: OTHER,
      role: 'admin',
      type: 'user',
    })
    resolveSessionRole.mockResolvedValue('user')
    const res = await call()
    expect(res.status).toBe(404)
    expect(userFindFirst).not.toHaveBeenCalled()
  })

  it('answers 404 to a signed-in caller without a principal', async () => {
    getSession.mockResolvedValue({ user: { id: OTHER, email: 'c@example.com' } })
    principalFindFirst.mockResolvedValue(undefined)
    const res = await call()
    expect(res.status).toBe(404)
    expect(resolveSessionRole).not.toHaveBeenCalled()
  })

  it('redirects the account itself to its own avatar', async () => {
    getSession.mockResolvedValue({ user: { id: TARGET, email: 'me@example.com' } })
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.example.com/avatars/a.png')
    expect(resolveSessionRole).not.toHaveBeenCalled()
  })

  it.each(['admin', 'member'])('redirects a %s to the avatar', async (role) => {
    getSession.mockResolvedValue({ user: { id: OTHER, email: 'staff@venturi.systems' } })
    principalFindFirst.mockResolvedValue({ id: 'principal_1', userId: OTHER, role, type: 'user' })
    resolveSessionRole.mockResolvedValue(role)
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://cdn.example.com/avatars/a.png')
  })

  it('redirects to the provider image when there is no uploaded avatar', async () => {
    getSession.mockResolvedValue({ user: { id: TARGET, email: 'me@example.com' } })
    userFindFirst.mockResolvedValue({ imageKey: null, image: 'https://avatars.example.com/me' })
    const res = await call()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://avatars.example.com/me')
  })

  it('answers 404 when the permitted caller asks for an unknown id', async () => {
    getSession.mockResolvedValue({ user: { id: TARGET, email: 'me@example.com' } })
    userFindFirst.mockResolvedValue(undefined)
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'User not found' })
  })
})
