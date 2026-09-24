/**
 * Team identity rule (owner decisions 6 and 7, landing-page#2309): a team
 * role takes effect only for a verified address at a team domain from a
 * linked Google or GitHub account. These are the pure parts of the rule plus
 * the read-side cap, which is what neutralises a legacy password-only
 * administrator without rewriting its row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  accounts: [] as Array<{ userId: string; providerId: string }>,
  users: [] as Array<{ id: string; email: string | null; emailVerified: boolean }>,
}))

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      account: {
        findMany: async ({ where }: { where: { val: string } }) =>
          hoisted.accounts
            .filter((a) => a.userId === where.val)
            .map((a) => ({ providerId: a.providerId })),
      },
      user: {
        findFirst: async ({ where }: { where: { val: string } }) =>
          hoisted.users.find((u) => u.id === where.val),
      },
    },
  },
  account: { userId: 'account.userId' },
  user: { id: 'user.id' },
  eq: (col: string, val: string) => ({ col, val }),
}))

vi.mock('@/lib/server/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}))

const {
  emailDomainOf,
  isTeamDomainEmail,
  isTeamIdentityEligible,
  isDesignatedAdminEmail,
  teamIdentityGap,
  loadTeamIdentity,
  resolveTeamRole,
  _resetTeamIdentityLogForTests,
} = await import('../team-identity')
const { parseTeamEmailDomains, parseTeamAdminEmails, DEFAULT_TEAM_EMAIL_DOMAINS } =
  await import('@/lib/server/config')

const DOMAINS = ['venturi.systems']
const eligible = {
  email: 'ops@venturi.systems',
  emailVerified: true,
  providerIds: ['github'],
}

const savedDomains = process.env.VENTURI_TEAM_EMAIL_DOMAINS
const savedAdmins = process.env.VENTURI_TEAM_ADMIN_EMAILS

beforeEach(() => {
  hoisted.accounts.length = 0
  hoisted.users.length = 0
  _resetTeamIdentityLogForTests()
  delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  delete process.env.VENTURI_TEAM_ADMIN_EMAILS
})

afterEach(() => {
  if (savedDomains === undefined) delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  else process.env.VENTURI_TEAM_EMAIL_DOMAINS = savedDomains
  if (savedAdmins === undefined) delete process.env.VENTURI_TEAM_ADMIN_EMAILS
  else process.env.VENTURI_TEAM_ADMIN_EMAILS = savedAdmins
})

describe('configuration parsing', () => {
  it('defaults the team domains to venturi.systems when unset or empty', () => {
    expect(DEFAULT_TEAM_EMAIL_DOMAINS).toEqual(['venturi.systems'])
    expect(parseTeamEmailDomains(undefined)).toEqual(['venturi.systems'])
    expect(parseTeamEmailDomains('')).toEqual(['venturi.systems'])
    expect(parseTeamEmailDomains(' , ,')).toEqual(['venturi.systems'])
  })

  it('never lets a malformed value empty the list', () => {
    expect(parseTeamEmailDomains('not a domain,@venturi.systems')).toEqual(['venturi.systems'])
  })

  it('lower-cases, trims and de-duplicates valid hostnames', () => {
    expect(parseTeamEmailDomains(' Venturi.Systems , example.com,venturi.systems')).toEqual([
      'venturi.systems',
      'example.com',
    ])
  })

  it('parses the admin list as lower-cased addresses and drops junk', () => {
    expect(parseTeamAdminEmails(' Owner@Venturi.Systems, nope ,a@b@, ,x@venturi.systems')).toEqual([
      'owner@venturi.systems',
      'x@venturi.systems',
    ])
    expect(parseTeamAdminEmails(undefined)).toEqual([])
  })

  it('reads VENTURI_TEAM_EMAIL_DOMAINS at call time', () => {
    process.env.VENTURI_TEAM_EMAIL_DOMAINS = 'example.com'
    expect(isTeamDomainEmail('demo@example.com')).toBe(true)
    expect(isTeamDomainEmail('ops@venturi.systems')).toBe(false)
  })
})

describe('email domain matching', () => {
  it('extracts the lower-cased domain', () => {
    expect(emailDomainOf('Ops@Venturi.Systems')).toBe('venturi.systems')
    expect(emailDomainOf('no-at-sign')).toBeNull()
    expect(emailDomainOf('trailing@')).toBeNull()
    expect(emailDomainOf(null)).toBeNull()
  })

  it('matches domains exactly: subdomains and look-alikes never match', () => {
    expect(isTeamDomainEmail('ops@venturi.systems', DOMAINS)).toBe(true)
    expect(isTeamDomainEmail('ops@VENTURI.SYSTEMS', DOMAINS)).toBe(true)
    expect(isTeamDomainEmail('ops@eu.venturi.systems', DOMAINS)).toBe(false)
    expect(isTeamDomainEmail('ops@venturi.systems.attacker.example', DOMAINS)).toBe(false)
    expect(isTeamDomainEmail('ops@notventuri.systems', DOMAINS)).toBe(false)
  })

  it('uses the last @ so a quoted local part cannot smuggle a domain', () => {
    expect(isTeamDomainEmail('"a@venturi.systems"@gmail.com', DOMAINS)).toBe(false)
  })
})

describe('teamIdentityGap', () => {
  it('accepts a verified team-domain address with a Google or GitHub link', () => {
    expect(teamIdentityGap(eligible, DOMAINS)).toBeNull()
    expect(teamIdentityGap({ ...eligible, providerIds: ['google'] }, DOMAINS)).toBeNull()
    expect(isTeamIdentityEligible(eligible, DOMAINS)).toBe(true)
  })

  it('refuses the password credential alone (the bootstrap administrator shape)', () => {
    expect(
      teamIdentityGap({ ...eligible, emailVerified: false, providerIds: ['credential'] }, DOMAINS)
    ).toBe('email_unverified')
    expect(teamIdentityGap({ ...eligible, providerIds: ['credential'] }, DOMAINS)).toBe(
      'provider_missing'
    )
  })

  it('refuses an OIDC provider as the only link', () => {
    expect(teamIdentityGap({ ...eligible, providerIds: ['sso'] }, DOMAINS)).toBe('provider_missing')
  })

  it('refuses an unverified address even with a GitHub link', () => {
    expect(teamIdentityGap({ ...eligible, emailVerified: false }, DOMAINS)).toBe('email_unverified')
  })

  it('refuses an address outside the team domains', () => {
    expect(teamIdentityGap({ ...eligible, email: 'ops@gmail.com' }, DOMAINS)).toBe('email_domain')
  })

  it('refuses an account with no address', () => {
    expect(teamIdentityGap({ ...eligible, email: null }, DOMAINS)).toBe('email_missing')
  })
})

describe('isDesignatedAdminEmail', () => {
  it('matches case-insensitively against the configured list', () => {
    expect(isDesignatedAdminEmail('Owner@Venturi.Systems', ['owner@venturi.systems'])).toBe(true)
    expect(isDesignatedAdminEmail('other@venturi.systems', ['owner@venturi.systems'])).toBe(false)
    expect(isDesignatedAdminEmail(undefined, ['owner@venturi.systems'])).toBe(false)
  })
})

describe('loadTeamIdentity', () => {
  it('reads the email and verification from the user row when not given', async () => {
    hoisted.users.push({ id: 'user_1', email: 'ops@venturi.systems', emailVerified: true })
    hoisted.accounts.push({ userId: 'user_1', providerId: 'github' })
    expect(await loadTeamIdentity('user_1' as never)).toEqual(eligible)
  })

  it('uses the known email and flag and reads only the links', async () => {
    hoisted.accounts.push({ userId: 'user_2', providerId: 'google' })
    expect(
      await loadTeamIdentity('user_2' as never, { email: 'a@venturi.systems', emailVerified: true })
    ).toEqual({ email: 'a@venturi.systems', emailVerified: true, providerIds: ['google'] })
  })

  it('returns null for a missing user', async () => {
    expect(await loadTeamIdentity('user_missing' as never)).toBeNull()
  })
})

describe('resolveTeamRole (read-side cap)', () => {
  const human = (role: string) => ({ id: 'principal_1', role, type: 'user', userId: 'user_1' })

  it('keeps a team role for an eligible identity', async () => {
    expect(await resolveTeamRole(human('admin'), eligible)).toBe('admin')
    expect(await resolveTeamRole(human('member'), eligible)).toBe('member')
  })

  it('caps a stored admin whose identity fails the rule at contributor', async () => {
    expect(
      await resolveTeamRole(human('admin'), { ...eligible, providerIds: ['credential'] })
    ).toBe('user')
    expect(await resolveTeamRole(human('admin'), { ...eligible, emailVerified: false })).toBe(
      'user'
    )
    expect(await resolveTeamRole(human('member'), { ...eligible, email: 'x@gmail.com' })).toBe(
      'user'
    )
  })

  it('loads the identity itself when the caller did not', async () => {
    hoisted.users.push({ id: 'user_1', email: 'ops@venturi.systems', emailVerified: true })
    expect(await resolveTeamRole(human('admin'))).toBe('user')
    hoisted.accounts.push({ userId: 'user_1', providerId: 'github' })
    expect(await resolveTeamRole(human('admin'))).toBe('admin')
  })

  it('never lets a non-human principal exercise a team role', async () => {
    expect(
      await resolveTeamRole(
        { id: 'p', role: 'admin', type: 'anonymous', userId: 'user_1' },
        eligible
      )
    ).toBe('user')
    expect(
      await resolveTeamRole({ id: 'p', role: 'admin', type: 'service', userId: null }, eligible)
    ).toBe('user')
  })

  it('costs no identity read for a contributor', async () => {
    expect(await resolveTeamRole(human('user'))).toBe('user')
  })
})
