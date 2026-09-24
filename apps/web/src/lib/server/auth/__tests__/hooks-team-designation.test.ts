/**
 * Team designation in the auth hooks (owner decisions 6 and 7,
 * landing-page#2309):
 *
 *  - handleTeamDesignationAfter applies VENTURI_TEAM_ADMIN_EMAILS and pending
 *    team invitations after a Google or GitHub sign-in, and only then.
 *  - handleUnlinkAccountGate refuses to unlink the last Google or GitHub
 *    account behind the only administrator who can act.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  applyTeamDesignation: vi.fn(),
  countEligibleAdmins: vi.fn(),
  principal: undefined as undefined | Record<string, unknown>,
  accounts: [] as Array<{ providerId: string; accountId: string }>,
}))

vi.mock('@/lib/server/domains/principals/team-designation', () => ({
  applyTeamDesignation: (input: unknown) => hoisted.applyTeamDesignation(input),
  withTeamRoleLock: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}),
  countEligibleAdmins: (...args: unknown[]) => hoisted.countEligibleAdmins(...args),
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: { findFirst: async () => hoisted.principal },
      account: { findMany: async () => hoisted.accounts },
    },
  },
  principal: { userId: 'principal.userId' },
  account: { userId: 'account.userId' },
  eq: vi.fn(),
}))

vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
}))

const { handleTeamDesignationAfter, handleUnlinkAccountGate } = await import('../hooks')

const signedIn = { resolve: async () => ({ user: { id: 'user_owner' } }) }

beforeEach(() => {
  hoisted.applyTeamDesignation.mockReset()
  hoisted.applyTeamDesignation.mockResolvedValue(null)
  hoisted.countEligibleAdmins.mockReset()
  hoisted.principal = { id: 'principal_owner', role: 'admin', type: 'user' }
  hoisted.accounts = [{ providerId: 'github', accountId: 'gh_1' }]
})

describe('handleTeamDesignationAfter', () => {
  const callback = (provider: string, user?: Record<string, unknown>) => ({
    path: '/callback/:id',
    params: { id: provider },
    context: { newSession: user ? { user } : null },
  })

  it.each(['google', 'github'])('applies designation after a %s sign-in', async (provider) => {
    await handleTeamDesignationAfter(
      callback(provider, { id: 'user_owner', email: 'owner@venturi.systems' })
    )
    expect(hoisted.applyTeamDesignation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_owner',
        email: 'owner@venturi.systems',
        includeInvitations: true,
        source: 'sign_in',
      })
    )
  })

  it('applies designation after an ID-token Google sign-in', async () => {
    await handleTeamDesignationAfter({
      path: '/sign-in/social',
      body: { provider: 'google' },
      context: { newSession: { user: { id: 'user_owner', email: 'owner@venturi.systems' } } },
    })
    expect(hoisted.applyTeamDesignation).toHaveBeenCalledTimes(1)
  })

  it.each(['sso', 'microsoft', 'credential'])(
    'never designates after a %s sign-in',
    async (provider) => {
      await handleTeamDesignationAfter(
        callback(provider, { id: 'user_owner', email: 'owner@venturi.systems' })
      )
      expect(hoisted.applyTeamDesignation).not.toHaveBeenCalled()
    }
  )

  it('skips a sign-in the policy revoked (no new session)', async () => {
    await handleTeamDesignationAfter(callback('github'))
    expect(hoisted.applyTeamDesignation).not.toHaveBeenCalled()
  })

  it('skips paths that are not sign-in callbacks', async () => {
    await handleTeamDesignationAfter({
      path: '/magic-link/verify',
      context: { newSession: { user: { id: 'user_owner' } } },
    })
    expect(hoisted.applyTeamDesignation).not.toHaveBeenCalled()
  })

  it('never fails the sign-in when designation throws', async () => {
    hoisted.applyTeamDesignation.mockRejectedValue(new Error('db down'))
    await expect(
      handleTeamDesignationAfter(
        callback('github', { id: 'user_owner', email: 'o@venturi.systems' })
      )
    ).resolves.toBeUndefined()
  })
})

describe('handleUnlinkAccountGate', () => {
  const unlink = (providerId: string, accountId?: string) => ({
    path: '/unlink-account',
    body: { providerId, ...(accountId ? { accountId } : {}) },
  })

  it('refuses to unlink the only administrator’s last GitHub account', async () => {
    hoisted.countEligibleAdmins.mockResolvedValue(0)
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).rejects.toMatchObject({ body: expect.objectContaining({ code: 'last_admin_identity' }) })
  })

  it('allows it once another administrator who can act exists', async () => {
    hoisted.countEligibleAdmins.mockResolvedValue(1)
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).resolves.toBeUndefined()
  })

  it('allows it while another Google or GitHub link remains', async () => {
    hoisted.accounts = [
      { providerId: 'github', accountId: 'gh_1' },
      { providerId: 'google', accountId: 'g_1' },
    ]
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).resolves.toBeUndefined()
    expect(hoisted.countEligibleAdmins).not.toHaveBeenCalled()
  })

  it('ignores a non-administrator and other providers', async () => {
    hoisted.principal = { id: 'principal_x', role: 'member', type: 'user' }
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).resolves.toBeUndefined()
    hoisted.principal = { id: 'principal_owner', role: 'admin', type: 'user' }
    await expect(
      handleUnlinkAccountGate(unlink('credential'), signedIn.resolve as never)
    ).resolves.toBeUndefined()
    expect(hoisted.countEligibleAdmins).not.toHaveBeenCalled()
  })
})
