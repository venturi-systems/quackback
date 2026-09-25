/**
 * Venturi fork (landing-page#2309, owner decisions 6 and 7): an off-domain
 * OIDC email never gets a team role from SSO auto-provisioning.
 *
 * Upstream 59fe3ff6f (v0.13.0) provisions a claim-mapped role even when the
 * email is not at one of the callback provider's verified domains. The fork
 * keeps that gate for claim-mapped roles, and a team role also needs the team
 * identity rule (team-identity.ts): a verified address at a team domain from a
 * linked Google or GitHub account.
 *
 * Unlike jit-role.test.ts, this file does NOT stub the team-designation
 * module: `handleAutoProvisionAfter` runs against the real team-role writer
 * (setUserTeamRole, under the team-role lock) and the real team identity rule,
 * with only the database mocked, so each refusal below is the rule's own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Row = Record<string, unknown>

const hoisted = vi.hoisted(() => ({
  principal: undefined as undefined | { id: string; role: string; type: string },
  user: undefined as
    undefined | { email: string; emailVerified: boolean; name: string; image: string | null },
  providerIds: [] as string[],
  idToken: null as string | null,
  updates: [] as Row[],
  inserts: [] as Row[],
  audits: [] as Row[],
  locks: [] as unknown[],
}))

vi.mock('@/lib/server/db', () => {
  const db = {
    // The team-role writer's transaction runs on the same mocked tables.
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    execute: async (q: { values?: unknown[] }) => {
      hoisted.locks.push(q.values?.[0])
    },
    query: {
      principal: { findFirst: async () => hoisted.principal },
      account: {
        // readSsoClaims (hooks.ts) reads the stored ID token.
        findFirst: async () => ({ idToken: hoisted.idToken }),
        // loadProviderIds (team-identity.ts) reads the linked providers.
        findMany: async () => hoisted.providerIds.map((providerId) => ({ providerId })),
      },
      user: { findFirst: async () => hoisted.user },
    },
    update: () => ({
      set: (values: Row) => {
        hoisted.updates.push(values)
        return { where: async () => undefined }
      },
    }),
    insert: () => ({
      values: async (values: Row) => {
        hoisted.inserts.push(values)
      },
    }),
  }
  return {
    db,
    principal: { id: 'principal.id', userId: 'principal.userId', role: 'principal.role' },
    user: { id: 'user.id' },
    account: { userId: 'account.userId', providerId: 'account.providerId' },
    and: (...parts: unknown[]) => ({ op: 'and', parts }),
    eq: (col: unknown, val: unknown) => ({ col, val }),
    desc: (column: unknown) => ({ op: 'desc', column }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
  }
})

vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: async (event: Row) => {
    hoisted.audits.push(event)
  },
}))

const { handleAutoProvisionAfter } = await import('../hooks')

const savedDomains = process.env.VENTURI_TEAM_EMAIL_DOMAINS

/** An unsigned ID token whose payload carries `claims`, as readSsoClaims decodes it. */
function idTokenWith(claims: Row): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
}

/** One OIDC provider row that verifies `domain` and maps `roles` claims. */
function provider(domain: string) {
  return {
    id: 'idp_corp',
    registrationId: 'corp-idp',
    enabled: true,
    autoCreateUsers: true,
    // 'user' is the no-promote default: only a claim can drive promotion.
    autoProvisionRole: 'user',
    attributeMapping: {
      claimPath: 'roles',
      rules: [
        { whenContains: 'admin', role: 'admin' },
        { whenContains: 'member', role: 'member' },
      ],
    },
    domains: [
      {
        id: 'domain_1',
        name: domain,
        verificationToken: 't',
        verifiedAt: '2026-01-01',
        enforced: false,
        createdAt: '2026-01-01',
      },
    ],
  }
}

async function signIn(email: string, providerDomain: string) {
  const handler = handleAutoProvisionAfter as unknown as (
    ctx: Row,
    providers: readonly Row[],
    registeredOidcIds: Set<string>
  ) => Promise<void>
  await handler(
    {
      path: '/oauth2/callback/:providerId',
      params: { providerId: 'corp-idp' },
      context: { newSession: { user: { id: 'user_abc', email } } },
    },
    [provider(providerDomain)],
    new Set(['corp-idp'])
  )
}

beforeEach(() => {
  delete process.env.VENTURI_TEAM_EMAIL_DOMAINS // the default team domain, venturi.systems
  hoisted.principal = { id: 'principal_abc', role: 'user', type: 'user' }
  hoisted.user = undefined
  hoisted.providerIds = []
  hoisted.idToken = null
  hoisted.updates = []
  hoisted.inserts = []
  hoisted.audits = []
  hoisted.locks = []
})

afterEach(() => {
  if (savedDomains === undefined) delete process.env.VENTURI_TEAM_EMAIL_DOMAINS
  else process.env.VENTURI_TEAM_EMAIL_DOMAINS = savedDomains
})

describe('SSO auto-provisioning gives an off-domain OIDC email no team role', () => {
  it.each(['member', 'admin'])(
    'refuses a %s claim for an email outside the provider’s verified domain',
    async (claimed) => {
      // The case upstream 59fe3ff6f provisions: the IdP asserts the role, the
      // email is not at the provider's verified domain.
      hoisted.user = {
        email: 'james@quackback.io',
        emailVerified: true,
        name: 'James',
        image: null,
      }
      hoisted.providerIds = ['corp-idp', 'github']
      hoisted.idToken = idTokenWith({ roles: [claimed] })
      await signIn('james@quackback.io', 'venturi.systems')
      expect(hoisted.updates).toEqual([])
      expect(hoisted.inserts).toEqual([])
      expect(hoisted.audits).toEqual([])
    }
  )

  it.each(['member', 'admin'])(
    'refuses a %s claim for an email at the provider’s verified domain but not a team domain',
    async (claimed) => {
      // The provider's own domain gate passes (acme.com), so the refusal is the
      // team identity rule's: acme.com is not a team domain.
      hoisted.user = { email: 'alice@acme.com', emailVerified: true, name: 'Alice', image: null }
      hoisted.providerIds = ['corp-idp', 'google']
      hoisted.idToken = idTokenWith({ roles: [claimed] })
      await signIn('alice@acme.com', 'acme.com')
      expect(hoisted.updates).toEqual([])
      expect(hoisted.inserts).toEqual([])
      expect(hoisted.audits).toEqual([])
    }
  )

  it('does not recreate a soft-removed off-domain principal with a claimed team role', async () => {
    hoisted.principal = undefined
    hoisted.user = { email: 'alice@acme.com', emailVerified: true, name: 'Alice', image: null }
    hoisted.providerIds = ['corp-idp', 'google']
    hoisted.idToken = idTokenWith({ roles: ['admin'] })
    await signIn('alice@acme.com', 'acme.com')
    expect(hoisted.inserts).toEqual([])
    expect(hoisted.updates).toEqual([])
  })

  it('refuses a team-domain address that only the OIDC provider vouches for', async () => {
    // At the team domain and the provider's verified domain, but with no
    // linked Google or GitHub account: an OIDC sign-in alone never qualifies.
    hoisted.user = {
      email: 'ops@venturi.systems',
      emailVerified: true,
      name: 'Ops',
      image: null,
    }
    hoisted.providerIds = ['corp-idp']
    hoisted.idToken = idTokenWith({ roles: ['admin'] })
    await signIn('ops@venturi.systems', 'venturi.systems')
    expect(hoisted.updates).toEqual([])
  })

  it('control: applies the claimed role to a qualifying team identity', async () => {
    // Proves the refusals above are the rule's, not a harness that never
    // writes: a verified team-domain address with a linked GitHub account, at
    // the provider's verified domain, gets the claim-mapped role.
    hoisted.user = {
      email: 'ops@venturi.systems',
      emailVerified: true,
      name: 'Ops',
      image: null,
    }
    hoisted.providerIds = ['corp-idp', 'github']
    hoisted.idToken = idTokenWith({ roles: ['member'] })
    await signIn('ops@venturi.systems', 'venturi.systems')
    expect(hoisted.updates).toEqual([{ role: 'member' }])
    // The write ran under the team-role lock.
    expect(hoisted.locks).toEqual(['quackback:team_roles'])
  })

  it('control: recreates a soft-removed qualifying principal with the claimed role', async () => {
    hoisted.principal = undefined
    hoisted.user = {
      email: 'ops@venturi.systems',
      emailVerified: true,
      name: 'Ops',
      image: null,
    }
    hoisted.providerIds = ['corp-idp', 'google']
    hoisted.idToken = idTokenWith({ roles: ['admin'] })
    await signIn('ops@venturi.systems', 'venturi.systems')
    expect(hoisted.inserts).toEqual([
      expect.objectContaining({
        userId: 'user_abc',
        role: 'admin',
        displayName: 'Ops',
        lastSsoSignInAt: expect.any(Date),
      }),
    ])
    expect(hoisted.updates).toEqual([])
  })
})
