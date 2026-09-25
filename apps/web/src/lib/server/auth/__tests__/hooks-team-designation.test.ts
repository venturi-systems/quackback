/**
 * Team designation in the auth hooks (owner decisions 6 and 7,
 * landing-page#2309):
 *
 *  - handleTeamDesignationAfter applies VENTURI_TEAM_ADMIN_EMAILS and pending
 *    team invitations after a Google or GitHub sign-in, and only then.
 *  - handleUnlinkAccountGate refuses to unlink the last Google or GitHub
 *    account behind the only administrator who can act, and performs every
 *    Google or GitHub unlink itself: the read, the count and the delete run in
 *    the one transaction that holds the team-role lock (DEF-62). The
 *    concurrent case runs on PostgreSQL in unlink-account-lock-db.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => {
  const state = {
    applyTeamDesignation: vi.fn(),
    countEligibleAdmins: vi.fn(),
    principal: undefined as undefined | Record<string, unknown>,
    accounts: [] as Array<{ id: string; providerId: string; accountId: string }>,
    /** True only while the withTeamRoleLock callback runs. */
    locked: false,
    lockCount: 0,
    /** Every read and write, with whether it ran under the lock. */
    calls: [] as Array<{ op: string; locked: boolean; tx: unknown }>,
    deleted: [] as unknown[],
    tx: undefined as unknown,
  }
  const record = (op: string, tx: unknown) => state.calls.push({ op, locked: state.locked, tx })
  const tx = {
    query: {
      principal: {
        findFirst: async () => {
          record('principal.findFirst', tx)
          return state.principal
        },
      },
      account: {
        findMany: async () => {
          record('account.findMany', tx)
          return state.accounts
        },
      },
    },
    delete: () => ({
      where: async (cond: { val: unknown }) => {
        record('account.delete', tx)
        state.deleted.push(cond.val)
      },
    }),
  }
  state.tx = tx
  return state
})

vi.mock('@/lib/server/domains/principals/team-designation', () => ({
  applyTeamDesignation: (input: unknown) => hoisted.applyTeamDesignation(input),
  withTeamRoleLock: async <T>(fn: (tx: unknown) => Promise<T>) => {
    hoisted.lockCount += 1
    hoisted.locked = true
    try {
      return await fn(hoisted.tx)
    } finally {
      hoisted.locked = false
    }
  },
  countEligibleAdmins: (...args: unknown[]) => {
    hoisted.calls.push({ op: 'countEligibleAdmins', locked: hoisted.locked, tx: args[0] })
    return hoisted.countEligibleAdmins(...args)
  },
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

const { handleTeamDesignationAfter, handleUnlinkAccountGate } = await import('../hooks')

const sessionCreatedAt = { value: new Date() as Date | undefined }
const signedIn = {
  resolve: async () => ({
    user: { id: 'user_owner' },
    session: { createdAt: sessionCreatedAt.value },
  }),
}

beforeEach(() => {
  hoisted.applyTeamDesignation.mockReset()
  hoisted.applyTeamDesignation.mockResolvedValue(null)
  hoisted.countEligibleAdmins.mockReset()
  hoisted.principal = { id: 'principal_owner', role: 'admin', type: 'user' }
  // The GitHub link and the password credential: GitHub is the last team link.
  hoisted.accounts = [
    { id: 'account_gh', providerId: 'github', accountId: 'gh_1' },
    { id: 'account_pw', providerId: 'credential', accountId: 'user_owner' },
  ]
  hoisted.locked = false
  hoisted.lockCount = 0
  hoisted.calls = []
  hoisted.deleted = []
  sessionCreatedAt.value = new Date()
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
  const unlink = (providerId: string, accountId?: string, freshAge?: number) => ({
    path: '/unlink-account',
    body: { providerId, ...(accountId ? { accountId } : {}) },
    ...(freshAge === undefined ? {} : { context: { sessionConfig: { freshAge } } }),
  })

  it('refuses to unlink the only administrator’s last GitHub account', async () => {
    hoisted.countEligibleAdmins.mockResolvedValue(0)
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).rejects.toMatchObject({ body: expect.objectContaining({ code: 'last_admin_identity' }) })
    expect(hoisted.deleted).toEqual([])
  })

  it('unlinks it once another administrator who can act exists', async () => {
    hoisted.countEligibleAdmins.mockResolvedValue(1)
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).resolves.toEqual({ status: true })
    expect(hoisted.deleted).toEqual(['account_gh'])
    expect(hoisted.countEligibleAdmins).toHaveBeenCalledWith(hoisted.tx, 'principal_owner')
  })

  it('reads, counts and deletes in the one transaction that holds the lock', async () => {
    hoisted.countEligibleAdmins.mockResolvedValue(1)
    await handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    expect(hoisted.lockCount).toBe(1)
    expect(hoisted.calls.map((c) => c.op)).toEqual([
      'account.findMany',
      'principal.findFirst',
      'countEligibleAdmins',
      'account.delete',
    ])
    for (const call of hoisted.calls) {
      expect(call).toMatchObject({ locked: true, tx: hoisted.tx })
    }
  })

  it('unlinks while another Google or GitHub link remains, without counting', async () => {
    hoisted.accounts = [
      { id: 'account_gh', providerId: 'github', accountId: 'gh_1' },
      { id: 'account_g', providerId: 'google', accountId: 'g_1' },
    ]
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).resolves.toEqual({ status: true })
    expect(hoisted.countEligibleAdmins).not.toHaveBeenCalled()
    expect(hoisted.deleted).toEqual(['account_gh'])
  })

  it('counts a second link of the same provider as a remaining team link', async () => {
    hoisted.accounts = [
      { id: 'account_gh1', providerId: 'github', accountId: 'gh_1' },
      { id: 'account_gh2', providerId: 'github', accountId: 'gh_2' },
    ]
    await expect(
      handleUnlinkAccountGate(unlink('github', 'gh_2'), signedIn.resolve as never)
    ).resolves.toEqual({ status: true })
    expect(hoisted.countEligibleAdmins).not.toHaveBeenCalled()
    expect(hoisted.deleted).toEqual(['account_gh2'])
  })

  it('unlinks for a non-administrator under the lock, without counting', async () => {
    hoisted.principal = { id: 'principal_x', role: 'member', type: 'user' }
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).resolves.toEqual({ status: true })
    expect(hoisted.countEligibleAdmins).not.toHaveBeenCalled()
    expect(hoisted.lockCount).toBe(1)
    expect(hoisted.deleted).toEqual(['account_gh'])
  })

  it('leaves other providers to Better Auth', async () => {
    await expect(
      handleUnlinkAccountGate(unlink('credential'), signedIn.resolve as never)
    ).resolves.toBeUndefined()
    await expect(
      handleUnlinkAccountGate(unlink('sso'), signedIn.resolve as never)
    ).resolves.toBeUndefined()
    expect(hoisted.lockCount).toBe(0)
    expect(hoisted.deleted).toEqual([])
  })

  it('leaves a body Better Auth’s schema rejects to Better Auth', async () => {
    await expect(
      handleUnlinkAccountGate(
        { path: '/unlink-account', body: { providerId: 'github', accountId: 7 } },
        signedIn.resolve as never
      )
    ).resolves.toBeUndefined()
    expect(hoisted.lockCount).toBe(0)
  })

  it('refuses without a session, as Better Auth would, and never reaches its delete', async () => {
    await expect(
      handleUnlinkAccountGate(unlink('github'), (async () => null) as never)
    ).rejects.toMatchObject({ body: expect.objectContaining({ code: 'UNAUTHORIZED' }) })
    expect(hoisted.lockCount).toBe(0)
  })

  it('refuses a session older than Better Auth’s fresh age', async () => {
    hoisted.countEligibleAdmins.mockResolvedValue(1)
    sessionCreatedAt.value = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await expect(
      handleUnlinkAccountGate(unlink('github', undefined, 60 * 60), signedIn.resolve as never)
    ).rejects.toMatchObject({ body: expect.objectContaining({ code: 'SESSION_NOT_FRESH' }) })
    // The default fresh age is one day, and 0 turns the check off.
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).resolves.toEqual({ status: true })
    sessionCreatedAt.value = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    hoisted.deleted = []
    await expect(
      handleUnlinkAccountGate(unlink('github', undefined, 0), signedIn.resolve as never)
    ).resolves.toEqual({ status: true })
    sessionCreatedAt.value = undefined
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).rejects.toMatchObject({ body: expect.objectContaining({ code: 'SESSION_NOT_FRESH' }) })
  })

  it('refuses to unlink the account’s only linked account, as Better Auth does', async () => {
    hoisted.accounts = [{ id: 'account_gh', providerId: 'github', accountId: 'gh_1' }]
    await expect(
      handleUnlinkAccountGate(unlink('github'), signedIn.resolve as never)
    ).rejects.toMatchObject({
      body: expect.objectContaining({ code: 'FAILED_TO_UNLINK_LAST_ACCOUNT' }),
    })
    expect(hoisted.deleted).toEqual([])
  })

  it('answers ACCOUNT_NOT_FOUND for a link the account does not have', async () => {
    await expect(
      handleUnlinkAccountGate(unlink('github', 'gh_other'), signedIn.resolve as never)
    ).rejects.toMatchObject({ body: expect.objectContaining({ code: 'ACCOUNT_NOT_FOUND' }) })
    await expect(
      handleUnlinkAccountGate(unlink('google'), signedIn.resolve as never)
    ).rejects.toMatchObject({ body: expect.objectContaining({ code: 'ACCOUNT_NOT_FOUND' }) })
    expect(hoisted.deleted).toEqual([])
  })
})
