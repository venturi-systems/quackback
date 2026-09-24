/**
 * Admin > Team read model: which stored team roles can act, and which
 * contributors an administrator could designate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  links: [] as Array<{ userId: string; providerId: string }>,
  contributors: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/server/db', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => hoisted.contributors,
  }
  return {
    db: {
      query: {
        account: {
          findMany: async ({ where }: { where: { userIds: string[] } }) =>
            hoisted.links.filter((l) => where.userIds.includes(l.userId)),
        },
      },
      select: () => chain,
    },
    account: { userId: 'account.userId', providerId: 'account.providerId' },
    principal: {},
    user: {},
    and: (...parts: Array<{ userIds?: string[] }>) => ({
      userIds: parts.find((p) => p.userIds)?.userIds ?? [],
    }),
    inArray: (col: string, vals: string[]) => (col === 'account.userId' ? { userIds: vals } : {}),
    eq: vi.fn(),
    or: vi.fn(),
    ilike: vi.fn(),
  }
})

vi.mock('@/lib/server/config', () => ({
  config: { teamEmailDomains: ['venturi.systems'], teamAdminEmails: [] },
}))

const { loadTeamDesignationView } = await import('../team-designation-view')

beforeEach(() => {
  hoisted.links = []
  hoisted.contributors = []
})

describe('loadTeamDesignationView', () => {
  it('marks a stored team role that fails the rule with its gap', async () => {
    hoisted.links = [{ userId: 'user_owner', providerId: 'github' }]
    const view = await loadTeamDesignationView(
      [
        {
          principalId: 'principal_owner',
          userId: 'user_owner',
          email: 'owner@venturi.systems',
          emailVerified: true,
        },
        {
          principalId: 'principal_bootstrap',
          userId: 'user_bootstrap',
          email: 'admin@venturi.systems',
          emailVerified: false,
        },
      ],
      { includeCandidates: false }
    )
    expect(view.gaps).toEqual({
      principal_owner: null,
      principal_bootstrap: 'email_unverified',
    })
    expect(view.candidates).toEqual([])
    expect(view.policy.domains).toEqual(['venturi.systems'])
  })

  it('lists only contributors who satisfy the rule, for administrators', async () => {
    hoisted.contributors = [
      {
        principalId: 'principal_ok',
        userId: 'user_ok',
        name: 'Ok',
        email: 'ok@venturi.systems',
        emailVerified: true,
      },
      {
        principalId: 'principal_pw',
        userId: 'user_pw',
        name: 'Password only',
        email: 'pw@venturi.systems',
        emailVerified: true,
      },
    ]
    hoisted.links = [{ userId: 'user_ok', providerId: 'google' }]
    const view = await loadTeamDesignationView([], { includeCandidates: true })
    expect(view.candidates).toEqual([
      { principalId: 'principal_ok', name: 'Ok', email: 'ok@venturi.systems' },
    ])
  })
})
