/**
 * Team designation writes (owner decisions 6 and 7, landing-page#2309).
 *
 *  - Every promotion needs an identity that satisfies the team identity rule;
 *    the server refuses anything else.
 *  - No change may leave the workspace without an administrator who can act:
 *    the check counts only administrators whose identity satisfies the rule,
 *    and runs under the same advisory lock as the write.
 *  - VENTURI_TEAM_ADMIN_EMAILS only promotes, and only a qualifying identity;
 *    a pending team invitation applies at the invitee's Google or GitHub
 *    sign-in.
 *  - setUserTeamRole (SSO auto-provisioning, invitation acceptance) reads the
 *    principal under the lock, so a role another writer set after the
 *    caller's own read is the one its mode and the rules check.
 *
 * The tables are an in-memory store driven through the same drizzle operator
 * shapes the code uses, so the real queries and transaction run against it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, unknown>
type Cond =
  | { op: 'eq'; col: string; val: unknown }
  | { op: 'and'; conds: Cond[] }
  | { op: 'in'; col: string; vals: unknown[] }
  | { op: 'gt'; col: string; val: unknown }

const store = vi.hoisted(() => ({
  principal: [] as Array<Record<string, unknown>>,
  user: [] as Array<Record<string, unknown>>,
  account: [] as Array<Record<string, unknown>>,
  invitation: [] as Array<Record<string, unknown>>,
  locks: [] as string[],
  // Run once when the next lock is taken: a writer that commits between the
  // caller's first read and its locked transaction.
  lockHooks: [] as Array<() => void>,
  audits: [] as Array<Record<string, unknown>>,
  cacheDeletes: [] as string[],
  revoked: [] as string[][],
}))

const col = (table: string) =>
  new Proxy({}, { get: (_t, key) => `${table}.${String(key)}` }) as Record<string, string>

function field(row: Row, table: string, c: string): unknown {
  const [t, f] = c.split('.')
  return t === table ? row[f] : undefined
}

function matches(row: Row, table: string, cond: Cond | undefined): boolean {
  if (!cond) return true
  switch (cond.op) {
    case 'and':
      return cond.conds.every((c) => matches(row, table, c))
    case 'eq':
      return field(row, table, cond.col) === cond.val
    case 'in':
      return cond.vals.includes(field(row, table, cond.col))
    case 'gt': {
      const v = field(row, table, cond.col)
      return v instanceof Date && cond.val instanceof Date && v > cond.val
    }
  }
}

function rows(table: string): Row[] {
  return (store as unknown as Record<string, Row[]>)[table]
}

function withUser(p: Row): Row {
  return { ...p, user: store.user.find((u) => u.id === p.userId) ?? null }
}

function tableQuery(table: string) {
  return {
    findFirst: async ({ where }: { where?: Cond } = {}) => {
      const hit = rows(table).find((r) => matches(r, table, where))
      return hit && table === 'principal' ? withUser(hit) : hit
    },
    findMany: async ({ where }: { where?: Cond } = {}) => {
      const hits = rows(table).filter((r) => matches(r, table, where))
      return table === 'principal' ? hits.map(withUser) : hits
    },
  }
}

const db = {
  query: {
    principal: tableQuery('principal'),
    user: tableQuery('user'),
    account: tableQuery('account'),
    invitation: tableQuery('invitation'),
  },
  execute: async (q: { values?: unknown[] }) => {
    store.locks.push(String(q.values?.[0]))
    for (const hook of store.lockHooks.splice(0)) hook()
  },
  insert: (t: Record<string, string>) => ({
    values: async (v: Row) => {
      rows(String(t.id).split('.')[0]).push({ ...v })
    },
  }),
  update: (t: Record<string, string>) => ({
    set: (v: Row) => ({
      where: async (cond: Cond) => {
        const table = String(t.id).split('.')[0]
        for (const r of rows(table)) if (matches(r, table, cond)) Object.assign(r, v)
      },
    }),
  }),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
}

vi.mock('@/lib/server/db', () => ({
  db,
  principal: col('principal'),
  user: col('user'),
  account: col('account'),
  invitation: col('invitation'),
  eq: (c: string, val: unknown) => ({ op: 'eq', col: c, val }),
  and: (...conds: Cond[]) => ({ op: 'and', conds }),
  inArray: (c: string, vals: unknown[]) => ({ op: 'in', col: c, vals }),
  gt: (c: string, val: unknown) => ({ op: 'gt', col: c, val }),
  desc: (c: string) => c,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}))

vi.mock('@/lib/server/redis', () => ({
  cacheDel: async (key: string) => {
    store.cacheDeletes.push(key)
  },
  CACHE_KEYS: { PRINCIPAL_BY_USER: (id: string) => `principal:user:${id}` },
}))

vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: async (e: Record<string, unknown>) => {
    store.audits.push(e)
  },
}))

vi.mock('@/lib/server/auth/magic-link-mint', () => ({
  revokeMagicLinkTokens: async (tokens: string[]) => {
    store.revoked.push(tokens)
  },
}))

vi.mock('@/lib/server/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const {
  changeTeamRole,
  applyTeamDesignation,
  countEligibleAdmins,
  setUserTeamRole,
  TEAM_ROLE_LOCK_KEY,
} = await import('../team-designation')

/** Seed a person. `qualifies` = verified team address with a GitHub link. */
function person(
  key: string,
  role: string,
  opts: { qualifies?: boolean; email?: string; type?: string; providers?: string[] } = {}
) {
  const qualifies = opts.qualifies ?? true
  const email = opts.email ?? `${key}@venturi.systems`
  store.user.push({ id: `user_${key}`, email, emailVerified: qualifies })
  store.principal.push({
    id: `principal_${key}`,
    userId: `user_${key}`,
    role,
    type: opts.type ?? 'user',
  })
  for (const providerId of opts.providers ?? (qualifies ? ['github'] : ['credential'])) {
    store.account.push({ userId: `user_${key}`, providerId })
  }
}

const roleOf = (key: string) => store.principal.find((p) => p.id === `principal_${key}`)?.role
const P = (key: string) => `principal_${key}` as never

const savedAdmins = process.env.VENTURI_TEAM_ADMIN_EMAILS
const savedDomains = process.env.VENTURI_TEAM_EMAIL_DOMAINS

beforeEach(() => {
  for (const key of Object.keys(store) as Array<keyof typeof store>) {
    ;(store[key] as unknown[]).length = 0
  }
  delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  process.env.VENTURI_TEAM_ADMIN_EMAILS = 'owner@venturi.systems'
})

afterEach(() => {
  if (savedAdmins === undefined) delete process.env.VENTURI_TEAM_ADMIN_EMAILS
  else process.env.VENTURI_TEAM_ADMIN_EMAILS = savedAdmins
  if (savedDomains === undefined) delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  else process.env.VENTURI_TEAM_EMAIL_DOMAINS = savedDomains
})

describe('countEligibleAdmins', () => {
  it('counts only administrators whose identity satisfies the rule', async () => {
    person('owner', 'admin')
    person('bootstrap', 'admin', { qualifies: false })
    person('member', 'member')
    expect(await countEligibleAdmins(db as never)).toBe(1)
    expect(await countEligibleAdmins(db as never, P('owner'))).toBe(0)
  })
})

describe('changeTeamRole', () => {
  it('refuses a change to your own role', async () => {
    person('owner', 'admin')
    await expect(
      changeTeamRole({
        principalId: P('owner'),
        newRole: 'member',
        actingPrincipalId: P('owner'),
        requireTeamTarget: true,
      })
    ).rejects.toMatchObject({ code: 'CANNOT_MODIFY_SELF' })
    await expect(
      changeTeamRole({
        principalId: P('owner'),
        newRole: 'user',
        actingPrincipalId: P('owner'),
        requireTeamTarget: true,
      })
    ).rejects.toMatchObject({ code: 'CANNOT_REMOVE_SELF' })
  })

  it('takes the team-role advisory lock', async () => {
    person('owner', 'admin')
    person('ops', 'user')
    await changeTeamRole({
      principalId: P('ops'),
      newRole: 'member',
      actingPrincipalId: P('owner'),
      requireTeamTarget: false,
    })
    expect(store.locks).toEqual([TEAM_ROLE_LOCK_KEY])
  })

  it('promotes a qualifying contributor', async () => {
    person('owner', 'admin')
    person('ops', 'user')
    const result = await changeTeamRole({
      principalId: P('ops'),
      newRole: 'admin',
      actingPrincipalId: P('owner'),
      requireTeamTarget: false,
    })
    expect(result).toMatchObject({ previousRole: 'user', newRole: 'admin', changed: true })
    expect(roleOf('ops')).toBe('admin')
  })

  it.each([
    ['a password-only account', { qualifies: false }],
    ['an address outside the team domains', { email: 'ops@gmail.com' }],
    ['a verified team address with only an OIDC link', { providers: ['sso'] }],
  ])('refuses to promote %s', async (_label, opts) => {
    person('owner', 'admin')
    person('ops', 'user', opts)
    await expect(
      changeTeamRole({
        principalId: P('ops'),
        newRole: 'member',
        actingPrincipalId: P('owner'),
        requireTeamTarget: false,
      })
    ).rejects.toMatchObject({ code: 'TEAM_IDENTITY_REQUIRED' })
    expect(roleOf('ops')).toBe('user')
  })

  it('refuses a team role for a service principal', async () => {
    person('owner', 'admin')
    store.principal.push({ id: 'principal_key', userId: null, role: 'user', type: 'service' })
    await expect(
      changeTeamRole({
        principalId: 'principal_key' as never,
        newRole: 'admin',
        actingPrincipalId: P('owner'),
        requireTeamTarget: false,
      })
    ).rejects.toMatchObject({ code: 'TEAM_IDENTITY_REQUIRED' })
  })

  it('refuses to demote the last administrator who can act, even beside a legacy admin row', async () => {
    person('owner', 'admin')
    person('bootstrap', 'admin', { qualifies: false })
    // An actor other than the owner (for example a concurrent request that
    // resolved before a demotion) must still be refused.
    await expect(
      changeTeamRole({ principalId: P('owner'), newRole: 'member', requireTeamTarget: true })
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' })
    await expect(
      changeTeamRole({ principalId: P('owner'), newRole: 'user', requireTeamTarget: true })
    ).rejects.toMatchObject({ code: 'LAST_ADMIN', message: 'Cannot remove the last admin' })
    expect(roleOf('owner')).toBe('admin')
  })

  it('demotes the legacy bootstrap administrator once a qualifying administrator exists', async () => {
    person('owner', 'admin')
    person('bootstrap', 'admin', { qualifies: false })
    await changeTeamRole({
      principalId: P('bootstrap'),
      newRole: 'user',
      actingPrincipalId: P('owner'),
      requireTeamTarget: true,
    })
    expect(roleOf('bootstrap')).toBe('user')
    expect(roleOf('owner')).toBe('admin')
  })

  it('lets one qualifying administrator demote another', async () => {
    person('owner', 'admin')
    person('second', 'admin')
    await changeTeamRole({
      principalId: P('second'),
      newRole: 'member',
      actingPrincipalId: P('owner'),
      requireTeamTarget: true,
    })
    expect(roleOf('second')).toBe('member')
  })

  it('keeps member management from touching a contributor', async () => {
    person('owner', 'admin')
    person('ops', 'user')
    await expect(
      changeTeamRole({
        principalId: P('ops'),
        newRole: 'admin',
        actingPrincipalId: P('owner'),
        requireTeamTarget: true,
      })
    ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' })
  })
})

describe('applyTeamDesignation (VENTURI_TEAM_ADMIN_EMAILS and invitations)', () => {
  it('promotes a designated address with a qualifying identity to admin', async () => {
    person('owner', 'user')
    const result = await applyTeamDesignation({
      userId: 'user_owner' as never,
      email: 'Owner@Venturi.Systems',
      includeInvitations: false,
      source: 'session',
    })
    expect(result).toMatchObject({
      previousRole: 'user',
      newRole: 'admin',
      reason: 'designated_admin_email',
    })
    expect(roleOf('owner')).toBe('admin')
    expect(store.cacheDeletes).toEqual(['principal:user:user_owner'])
    expect(store.audits).toEqual([
      expect.objectContaining({
        event: 'user.role.changed',
        before: { role: 'user' },
        after: { role: 'admin' },
        metadata: expect.objectContaining({
          source: 'VENTURI_TEAM_ADMIN_EMAILS',
          trigger: 'session',
        }),
      }),
    ])
  })

  it('never promotes a designated address whose identity fails the rule', async () => {
    person('owner', 'user', { qualifies: false })
    expect(
      await applyTeamDesignation({
        userId: 'user_owner' as never,
        email: 'owner@venturi.systems',
        includeInvitations: false,
        source: 'sign_in',
      })
    ).toBeNull()
    expect(roleOf('owner')).toBe('user')
    expect(store.locks).toEqual([])
  })

  it('does nothing for an address that is not designated', async () => {
    person('ops', 'user')
    expect(
      await applyTeamDesignation({
        userId: 'user_ops' as never,
        email: 'ops@venturi.systems',
        includeInvitations: false,
        source: 'session',
      })
    ).toBeNull()
    expect(roleOf('ops')).toBe('user')
  })

  it('never lowers an existing role', async () => {
    person('owner', 'admin')
    expect(
      await applyTeamDesignation({
        userId: 'user_owner' as never,
        email: 'owner@venturi.systems',
        includeInvitations: true,
        source: 'sign_in',
      })
    ).toBeNull()
    expect(roleOf('owner')).toBe('admin')
  })

  it('accepts a pending team invitation at a qualifying sign-in', async () => {
    person('ops', 'user')
    store.invitation.push({
      id: 'invite_1',
      kind: 'team',
      status: 'pending',
      email: 'ops@venturi.systems',
      role: 'member',
      expiresAt: new Date(Date.now() + 60_000),
      magicLinkTokens: ['tok_a'],
    })
    const result = await applyTeamDesignation({
      userId: 'user_ops' as never,
      email: 'ops@venturi.systems',
      includeInvitations: true,
      source: 'sign_in',
    })
    expect(result).toMatchObject({ newRole: 'member', reason: 'team_invitation' })
    expect(roleOf('ops')).toBe('member')
    expect(store.invitation[0].status).toBe('accepted')
    expect(store.revoked).toEqual([['tok_a']])
  })

  it('ignores an expired invitation', async () => {
    person('ops', 'user')
    store.invitation.push({
      id: 'invite_1',
      kind: 'team',
      status: 'pending',
      email: 'ops@venturi.systems',
      role: 'admin',
      expiresAt: new Date(Date.now() - 60_000),
      magicLinkTokens: [],
    })
    expect(
      await applyTeamDesignation({
        userId: 'user_ops' as never,
        email: 'ops@venturi.systems',
        includeInvitations: true,
        source: 'sign_in',
      })
    ).toBeNull()
    expect(roleOf('ops')).toBe('user')
  })

  it('never applies an invitation to an identity that fails the rule', async () => {
    person('ops', 'user', { providers: ['credential'] })
    store.invitation.push({
      id: 'invite_1',
      kind: 'team',
      status: 'pending',
      email: 'ops@venturi.systems',
      role: 'admin',
      expiresAt: new Date(Date.now() + 60_000),
      magicLinkTokens: [],
    })
    expect(
      await applyTeamDesignation({
        userId: 'user_ops' as never,
        email: 'ops@venturi.systems',
        includeInvitations: true,
        source: 'sign_in',
      })
    ).toBeNull()
    expect(roleOf('ops')).toBe('user')
    expect(store.invitation[0].status).toBe('pending')
  })

  it('checks the identity again under the lock', async () => {
    // The owner qualifies at the first read, then an unlink commits before
    // the designation takes the lock: the locked read is what decides.
    person('owner', 'user')
    store.lockHooks.push(() => {
      store.account.length = 0
    })
    expect(
      await applyTeamDesignation({
        userId: 'user_owner' as never,
        email: 'owner@venturi.systems',
        includeInvitations: false,
        source: 'session',
      })
    ).toBeNull()
    expect(roleOf('owner')).toBe('user')
  })

  it('skips an anonymous principal even at a designated address', async () => {
    person('owner', 'user', { type: 'anonymous' })
    expect(
      await applyTeamDesignation({
        userId: 'user_owner' as never,
        email: 'owner@venturi.systems',
        includeInvitations: false,
        source: 'session',
      })
    ).toBeNull()
    expect(roleOf('owner')).toBe('user')
  })
})

describe('setUserTeamRole (SSO auto-provisioning and invitation acceptance)', () => {
  const U = (key: string) => `user_${key}` as never

  it('promotes a qualifying contributor under the team-role lock', async () => {
    person('owner', 'admin')
    person('ops', 'user')
    const change = await setUserTeamRole({ userId: U('ops'), newRole: 'member', mode: 'from_user' })
    expect(change).toMatchObject({ previousRole: 'user', newRole: 'member' })
    expect(roleOf('ops')).toBe('member')
    expect(store.locks).toEqual([TEAM_ROLE_LOCK_KEY])
  })

  it('refuses a team role to an identity that fails the rule', async () => {
    person('owner', 'admin')
    person('ops', 'user', { providers: ['sso'] })
    await expect(
      setUserTeamRole({ userId: U('ops'), newRole: 'admin', mode: 'from_user' })
    ).rejects.toMatchObject({ code: 'TEAM_IDENTITY_REQUIRED' })
    expect(roleOf('ops')).toBe('user')
  })

  it('leaves a principal another writer promoted after the caller read it (from_user)', async () => {
    // The SSO hook read 'user' outside the lock; a designation made the
    // account admin before this transaction took the lock.
    person('owner', 'admin')
    person('ops', 'user')
    store.lockHooks.push(() => {
      store.principal.find((p) => p.id === 'principal_ops')!.role = 'admin'
    })
    expect(
      await setUserTeamRole({ userId: U('ops'), newRole: 'member', mode: 'from_user' })
    ).toBeNull()
    expect(roleOf('ops')).toBe('admin')
  })

  it('checks the last-admin rule against the role another writer set (set mode)', async () => {
    // Sync mode demotes. The hook read 'user'; by the time the lock is held
    // the account is the only eligible administrator, so the demotion is refused.
    person('bootstrap', 'admin', { qualifies: false })
    person('ops', 'user')
    store.lockHooks.push(() => {
      store.principal.find((p) => p.id === 'principal_ops')!.role = 'admin'
    })
    await expect(
      setUserTeamRole({ userId: U('ops'), newRole: 'member', mode: 'set' })
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' })
    expect(roleOf('ops')).toBe('admin')
  })

  it('demotes an administrator in set mode while another eligible one remains', async () => {
    person('owner', 'admin')
    person('ops', 'admin')
    const change = await setUserTeamRole({ userId: U('ops'), newRole: 'user', mode: 'set' })
    expect(change).toMatchObject({ previousRole: 'admin', newRole: 'user' })
    expect(roleOf('ops')).toBe('user')
  })

  it('never lowers a role in raise mode', async () => {
    person('owner', 'admin')
    person('ops', 'admin')
    expect(await setUserTeamRole({ userId: U('ops'), newRole: 'member', mode: 'raise' })).toBeNull()
    expect(roleOf('ops')).toBe('admin')
  })

  it('raises a member to admin in raise mode', async () => {
    person('owner', 'admin')
    person('ops', 'member')
    const change = await setUserTeamRole({ userId: U('ops'), newRole: 'admin', mode: 'raise' })
    expect(change).toMatchObject({ previousRole: 'member', newRole: 'admin' })
  })

  it('creates a missing principal with the role, under the lock', async () => {
    // "Remove from portal" deleted the principal and kept the auth user.
    person('owner', 'admin')
    store.user.push({
      id: 'user_ops',
      email: 'ops@venturi.systems',
      emailVerified: true,
      name: 'Ops',
      image: 'https://example.test/ops.png',
    })
    store.account.push({ userId: 'user_ops', providerId: 'github' })
    const signedInAt = new Date('2026-09-25T00:00:00Z')
    const change = await setUserTeamRole({
      userId: U('ops'),
      newRole: 'member',
      mode: 'from_user',
      create: { lastSsoSignInAt: signedInAt },
    })
    expect(change).toMatchObject({ previousRole: null, newRole: 'member' })
    expect(store.principal.find((p) => p.userId === 'user_ops')).toMatchObject({
      role: 'member',
      displayName: 'Ops',
      avatarUrl: 'https://example.test/ops.png',
      lastSsoSignInAt: signedInAt,
    })
    expect(store.locks).toEqual([TEAM_ROLE_LOCK_KEY])
  })

  it('uses the given display name for a created principal', async () => {
    person('owner', 'admin')
    store.user.push({ id: 'user_ops', email: 'ops@venturi.systems', emailVerified: true })
    store.account.push({ userId: 'user_ops', providerId: 'google' })
    await setUserTeamRole({
      userId: U('ops'),
      newRole: 'admin',
      mode: 'raise',
      create: { displayName: 'Operations' },
    })
    expect(store.principal.find((p) => p.userId === 'user_ops')).toMatchObject({
      role: 'admin',
      displayName: 'Operations',
    })
  })

  it('never creates a principal with a team role its identity cannot hold', async () => {
    person('owner', 'admin')
    store.user.push({ id: 'user_ops', email: 'ops@acme.example', emailVerified: true })
    store.account.push({ userId: 'user_ops', providerId: 'github' })
    await expect(
      setUserTeamRole({ userId: U('ops'), newRole: 'member', mode: 'from_user' })
    ).rejects.toMatchObject({ code: 'TEAM_IDENTITY_REQUIRED' })
    expect(store.principal.find((p) => p.userId === 'user_ops')).toBeUndefined()
  })

  it('creates nothing for a missing principal whose target is user', async () => {
    store.user.push({ id: 'user_ops', email: 'ops@venturi.systems', emailVerified: true })
    expect(await setUserTeamRole({ userId: U('ops'), newRole: 'user', mode: 'set' })).toBeNull()
    expect(store.principal).toEqual([])
  })
})
