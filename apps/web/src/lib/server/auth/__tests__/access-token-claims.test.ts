/**
 * OAuth access-token claims (landing-page#2309): the `role` claim is the role
 * the principal may exercise under the team identity rule, never the stored
 * role, so a client never reads `admin` for an account the rule treats as a
 * contributor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const principalFindFirst = vi.fn()
vi.mock('@/lib/server/db', () => ({
  db: { query: { principal: { findFirst: (...a: unknown[]) => principalFindFirst(...a) } } },
  principal: { userId: 'principal.userId' },
  eq: vi.fn(),
}))

// The rule itself is covered in team-identity.test.ts.
const resolveTeamRole = vi.fn()
vi.mock('@/lib/server/domains/principals/team-identity', () => ({
  resolveTeamRole: (...a: unknown[]) => resolveTeamRole(...a),
}))

const { accessTokenClaims } = await import('../access-token-claims')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('accessTokenClaims', () => {
  it('returns no claims without a user id', async () => {
    expect(await accessTokenClaims(undefined)).toEqual({})
    expect(await accessTokenClaims({ name: 'x' })).toEqual({})
    expect(principalFindFirst).not.toHaveBeenCalled()
  })

  it('carries the resolved role, not the stored one', async () => {
    const stored = { id: 'principal_1', role: 'admin', type: 'user', userId: 'user_1' }
    principalFindFirst.mockResolvedValue(stored)
    resolveTeamRole.mockResolvedValue('user')

    const claims = await accessTokenClaims({
      id: 'user_1',
      name: 'Bootstrap',
      email: 'bootstrap@example.com',
    })

    expect(resolveTeamRole).toHaveBeenCalledWith(stored)
    expect(claims).toEqual({
      principalId: 'principal_1',
      role: 'user',
      name: 'Bootstrap',
      email: 'bootstrap@example.com',
    })
  })

  it('keeps a team role the rule accepts', async () => {
    principalFindFirst.mockResolvedValue({
      id: 'principal_2',
      role: 'admin',
      type: 'user',
      userId: 'user_2',
    })
    resolveTeamRole.mockResolvedValue('admin')

    const claims = await accessTokenClaims({
      id: 'user_2',
      name: 'Owner',
      email: 'owner@venturi.systems',
    })
    expect(claims.role).toBe('admin')
  })

  it('claims the contributor role when the user has no principal', async () => {
    principalFindFirst.mockResolvedValue(undefined)
    const claims = await accessTokenClaims({ id: 'user_3', name: 'N', email: 'n@example.com' })
    expect(claims).toMatchObject({ principalId: undefined, role: 'user' })
    expect(resolveTeamRole).not.toHaveBeenCalled()
  })
})
