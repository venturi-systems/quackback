/**
 * Tests for `handleAutoProvisionAfter` role assignment.
 *
 * Task 13: the JIT auto-provision hook reads provisioning config from the
 * MATCHED PROVIDER ROW (`autoCreateUsers` / `autoProvisionRole` /
 * `attributeMapping`) and scopes the verified-domain check to that
 * provider's own domains. The target role defaults to 'member'; setting
 * 'user' disables promotion.
 *
 * The domain scoping uses the real `findProviderForDomainEmail` (over the
 * synthesized provider row's domains), so tests drive the "email not at a
 * verified domain" case by supplying a non-matching email rather than
 * mocking a predicate.
 *
 * Venturi fork: the verified-domain gate also covers a claim-mapped role
 * (upstream 59fe3ff6f removed that, and the fork does not take it). The team
 * identity rule is stubbed here; jit-role-team-identity.test.ts runs the same
 * handler against the real rule.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindFirst = vi.fn()
const mockAccountFindFirst = vi.fn()
const mockUserFindFirst = vi.fn()
const mockSet = vi.fn()
const mockWhere = vi.fn()
const mockInsertValues = vi.fn()
const mockRecordAuditEvent = vi.fn()
// Recordable so a test can assert `readSsoClaims` queries by the CALLBACK
// provider id rather than a hardcoded 'sso'.
const mockEq = vi.fn()

vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      principal: { findFirst: (...args: unknown[]) => mockFindFirst(...args) },
      account: { findFirst: (...args: unknown[]) => mockAccountFindFirst(...args) },
      user: { findFirst: (...args: unknown[]) => mockUserFindFirst(...args) },
    },
    update: () => ({ set: mockSet, where: mockWhere }),
    insert: () => ({ values: (...args: unknown[]) => mockInsertValues(...args) }),
  },
  principal: { userId: 'user_id', role: 'role' },
  user: { id: 'user.id' },
  account: { userId: 'account.userId', providerId: 'account.providerId' },
  and: vi.fn((...parts: unknown[]) => ({ op: 'and', parts })),
  eq: (...args: unknown[]) => mockEq(...args),
  // readSsoClaims (hooks.ts) orders the account lookup newest-first.
  desc: vi.fn((column: unknown) => ({ op: 'desc', column })),
}))

vi.mock('@/lib/server/audit/log', () => ({
  recordAuditEvent: (...args: unknown[]) => mockRecordAuditEvent(...args),
}))

// Team identity rule: stubbed here (team-designation.test.ts covers it). By
// default the account qualifies for a team role.
const mockTeamRoleGap = vi.fn(async (): Promise<string | null> => null)
const mockChangeTeamRole = vi.fn(async (): Promise<unknown> => ({ changed: true }))
vi.mock('@/lib/server/domains/principals/team-designation', () => ({
  teamRoleGapForUser: () => mockTeamRoleGap(),
  changeTeamRole: (...args: unknown[]) => mockChangeTeamRole(...(args as [])),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockTeamRoleGap.mockResolvedValue(null)
  mockChangeTeamRole.mockResolvedValue({ changed: true })
  mockSet.mockReturnValue({ where: mockWhere })
  mockWhere.mockResolvedValue(undefined)
  mockInsertValues.mockResolvedValue(undefined)
  mockUserFindFirst.mockResolvedValue({ name: 'Returning User', image: null })
  mockRecordAuditEvent.mockResolvedValue(undefined)
})

type SsoOidc = {
  enabled: boolean
  discoveryUrl: string
  clientId: string
  autoCreateUsers: boolean
  autoProvisionRole?: 'admin' | 'member' | 'user'
  attributeMapping?: {
    claimPath: string
    rules: { whenContains: string; role: 'admin' | 'member' | 'user' }[]
    syncOnEverySignIn?: boolean
  }
}

type CallOpts = {
  path?: string
  providerId?: string
  userId?: string
  email?: string
  ssoOidc?: Partial<SsoOidc>
  registeredIds?: Set<string>
}

const callHandlerWith = async (opts: CallOpts = {}) => {
  const mod = await import('../hooks')
  // Loose cast: the real 2nd param is IdentityProvider[]; the synthesized row
  // below carries only the fields the handler reads.
  const handler = mod.handleAutoProvisionAfter as unknown as (
    ctx: {
      path?: string
      params?: Record<string, unknown>
      context?: { newSession?: { user?: { id?: string; email?: string } } }
    },
    providers: ReadonlyArray<Record<string, unknown>>,
    registeredOidcIds: Set<string>
  ) => Promise<void>
  const providerId = opts.providerId ?? 'sso'
  const ssoOidc = {
    enabled: true,
    discoveryUrl: 'https://idp/well-known',
    clientId: 'c',
    autoCreateUsers: true,
    ...opts.ssoOidc,
  }
  await handler(
    {
      path: opts.path ?? '/oauth2/callback/:providerId',
      params: { providerId },
      context: {
        newSession: {
          user: { id: opts.userId ?? 'user_abc', email: opts.email ?? 'alice@acme.com' },
        },
      },
    },
    // The matched provider row supplies the per-provider provisioning config
    // and the verified domains the email is scoped against.
    [
      {
        id: 'idp_sso',
        registrationId: providerId,
        enabled: true,
        autoCreateUsers: ssoOidc.autoCreateUsers,
        autoProvisionRole: ssoOidc.autoProvisionRole ?? null,
        attributeMapping: ssoOidc.attributeMapping ?? null,
        domains: [
          {
            id: 'domain_1',
            name: 'acme.com',
            verificationToken: 't',
            verifiedAt: '2026-01-01',
            enforced: false,
            createdAt: '2026-01-01',
          },
        ],
      },
    ],
    // Task 12: the default provider id 'sso' must be in the registered-OIDC
    // set for the handler to fire; a 'google' callback (the skip test) is
    // absent and short-circuits via isRegisteredOidcProvider.
    opts.registeredIds ?? new Set(['sso'])
  )
}

const callHandler = (autoProvisionRole?: 'admin' | 'member' | 'user') =>
  callHandlerWith({ ssoOidc: { autoProvisionRole } })

describe('handleAutoProvisionAfter -- team identity rule', () => {
  it('refuses a team role to an OIDC account without a qualifying identity', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    mockTeamRoleGap.mockResolvedValue('provider_missing')
    await callHandler('admin')
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockRecordAuditEvent).not.toHaveBeenCalled()
  })
})

// Stub the account row's id_token with a JWT whose payload carries `claims`,
// so readSsoClaims (which base64url-decodes the middle segment) reads them.
const mockIdTokenClaims = (claims: Record<string, unknown>) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  mockAccountFindFirst.mockResolvedValue({ idToken: `h.${payload}.s` })
}

describe('handleAutoProvisionAfter -- role assignment', () => {
  it('uses autoProvisionRole=admin from config', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    await callHandler('admin')
    expect(mockSet).toHaveBeenCalledWith({ role: 'admin' })
  })

  it('uses autoProvisionRole=member from config', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    await callHandler('member')
    expect(mockSet).toHaveBeenCalledWith({ role: 'member' })
  })

  it('defaults to member when autoProvisionRole is undefined', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    await callHandler(undefined)
    expect(mockSet).toHaveBeenCalledWith({ role: 'member' })
  })

  it('does not promote when autoProvisionRole=user (portal-only)', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    await callHandler('user')
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('does not downgrade existing admin/member', async () => {
    mockFindFirst.mockResolvedValue({ role: 'admin' })
    await callHandler('member')
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('no-ops when the current role already equals the target', async () => {
    mockFindFirst.mockResolvedValue({ role: 'member' })
    await callHandler('member')
    expect(mockSet).not.toHaveBeenCalled()
  })
})

describe('handleAutoProvisionAfter -- guards (no-op short-circuits)', () => {
  it('skips when path is not the OAuth callback', async () => {
    await callHandlerWith({ path: '/sign-in/email' })
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('skips when providerId is not "sso" (e.g. google callback)', async () => {
    await callHandlerWith({ providerId: 'google' })
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('skips when autoCreateUsers=false (admin opted out)', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    await callHandlerWith({ ssoOidc: { autoCreateUsers: false } })
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('skips when the user email is not at the callback provider’s verified domain', async () => {
    // Provider owns acme.com; the email is at a different domain, so the
    // scoped findProviderForDomainEmail check returns null and we bail.
    await callHandlerWith({ email: 'alice@other.com' })
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })
})

describe('handleAutoProvisionAfter -- syncOnEverySignIn', () => {
  it('re-applies on every sign-in when attributeMapping.syncOnEverySignIn=true (and can demote)', async () => {
    mockFindFirst.mockResolvedValue({ id: 'principal_abc', role: 'admin' })
    mockAccountFindFirst.mockResolvedValue({ idToken: null })
    await callHandlerWith({
      ssoOidc: {
        autoProvisionRole: 'member',
        attributeMapping: {
          claimPath: 'roles',
          rules: [],
          syncOnEverySignIn: true,
        },
      },
    })
    // Taking admin away goes through the team-role writer (last-admin check).
    expect(mockChangeTeamRole).toHaveBeenCalledWith({
      principalId: 'principal_abc',
      newRole: 'member',
      requireTeamTarget: false,
    })
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('honours a resolved role="user" under sync mode (demotes existing admin)', async () => {
    mockFindFirst.mockResolvedValue({ id: 'principal_abc', role: 'admin' })
    mockAccountFindFirst.mockResolvedValue({ idToken: null })
    // With sync on, the resolved-from-claims role is authoritative on
    // every sign-in. attributeMapping has no matching rules, so the resolver
    // returns null and falls back to autoProvisionRole='user' — effectively
    // saying "this user has no team role". An existing admin gets demoted.
    await callHandlerWith({
      ssoOidc: {
        autoProvisionRole: 'user',
        attributeMapping: {
          claimPath: 'roles',
          rules: [],
          syncOnEverySignIn: true,
        },
      },
    })
    expect(mockChangeTeamRole).toHaveBeenCalledWith(
      expect.objectContaining({ principalId: 'principal_abc', newRole: 'user' })
    )
  })

  it('keeps the last administrator when sync mode would demote them', async () => {
    mockFindFirst.mockResolvedValue({ id: 'principal_abc', role: 'admin' })
    mockAccountFindFirst.mockResolvedValue({ idToken: null })
    mockChangeTeamRole.mockRejectedValue(Object.assign(new Error('last'), { code: 'LAST_ADMIN' }))
    await callHandlerWith({
      ssoOidc: {
        autoProvisionRole: 'user',
        attributeMapping: {
          claimPath: 'roles',
          rules: [],
          syncOnEverySignIn: true,
        },
      },
    })
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockRecordAuditEvent).not.toHaveBeenCalled()
  })
})

describe('handleAutoProvisionAfter -- audit on role change', () => {
  it('emits user.role.changed when promoting an existing portal user', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    await callHandler('member')

    // First-time promotion (p.role='user' is the bootstrap-only case)
    // doesn't emit because the audit branch only fires when p.role is
    // truthy AND different from targetRole. role='user' qualifies as
    // truthy, so the row IS emitted.
    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1)
    const call = mockRecordAuditEvent.mock.calls[0][0] as {
      event: string
      before: { role: string }
      after: { role: string }
      metadata: Record<string, unknown>
    }
    expect(call.event).toBe('user.role.changed')
    expect(call.before.role).toBe('user')
    expect(call.after.role).toBe('member')
    expect(call.metadata.source).toBe('auto_provision')
  })

  it('readSsoClaims queries the account by the CALLBACK provider id (not a hardcoded "sso")', async () => {
    // Regression guard: a revert to `eq(account.providerId, 'sso')` would make
    // attribute-mapping silently fall back to the default role for every
    // non-sso provider. The other mapping tests all run with providerId='sso',
    // so they can't catch it — this one drives a 'custom-oidc' callback.
    mockFindFirst.mockResolvedValue({ role: 'user' })
    mockAccountFindFirst.mockResolvedValue({ idToken: null })
    await callHandlerWith({
      providerId: 'custom-oidc',
      registeredIds: new Set(['custom-oidc']),
      ssoOidc: {
        attributeMapping: { claimPath: 'roles', rules: [] },
      },
    })
    expect(mockEq).toHaveBeenCalledWith('account.providerId', 'custom-oidc')
    expect(mockEq).not.toHaveBeenCalledWith('account.providerId', 'sso')
  })

  it('marks audit source=attribute_mapping when role came from claim resolution', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    mockAccountFindFirst.mockResolvedValue({ idToken: null })
    await callHandlerWith({
      ssoOidc: {
        autoProvisionRole: 'member',
        attributeMapping: {
          claimPath: 'roles',
          rules: [],
        },
      },
    })

    expect(mockRecordAuditEvent).toHaveBeenCalledTimes(1)
    const call = mockRecordAuditEvent.mock.calls[0][0] as {
      metadata: Record<string, unknown>
    }
    expect(call.metadata.source).toBe('attribute_mapping')
  })
})

describe('handleAutoProvisionAfter -- a claim-mapped role stays gated on the verified domain (Venturi fork)', () => {
  // Upstream 59fe3ff6f (v0.13.0) provisions a claim-mapped role even when the
  // email is NOT at one of the provider's verified domains. The Venturi fork
  // neutralizes that change (landing-page#2309, owner decisions 6 and 7): an
  // IdP claim never makes an off-domain email a team member. These tests are
  // the inverse of upstream's "domain-independent" tests.
  const mapping = {
    claimPath: 'roles',
    rules: [
      { whenContains: 'admin', role: 'admin' as const },
      { whenContains: 'member', role: 'member' as const },
    ],
  }

  it.each(['member', 'admin'] as const)(
    'gives an off-domain OIDC email no team role even when its claim maps to %s',
    async (claimed) => {
      mockFindFirst.mockResolvedValue({ id: 'principal_abc', role: 'user' })
      mockIdTokenClaims({ roles: [claimed] })
      await callHandlerWith({
        // Not at acme.com (the provider's only verified domain).
        email: 'james@quackback.io',
        ssoOidc: { autoProvisionRole: 'user', attributeMapping: mapping },
      })
      expect(mockSet).not.toHaveBeenCalled()
      expect(mockInsertValues).not.toHaveBeenCalled()
      expect(mockChangeTeamRole).not.toHaveBeenCalled()
      expect(mockRecordAuditEvent).not.toHaveBeenCalled()
    }
  )

  it('gives an off-domain OIDC email no team role under syncOnEverySignIn either', async () => {
    mockFindFirst.mockResolvedValue({ id: 'principal_abc', role: 'user' })
    mockIdTokenClaims({ roles: ['admin'] })
    await callHandlerWith({
      email: 'james@quackback.io',
      ssoOidc: {
        autoProvisionRole: 'user',
        attributeMapping: { ...mapping, syncOnEverySignIn: true },
      },
    })
    expect(mockSet).not.toHaveBeenCalled()
    expect(mockInsertValues).not.toHaveBeenCalled()
    expect(mockChangeTeamRole).not.toHaveBeenCalled()
  })

  it('refuses the gate before any claim or identity is read', async () => {
    // The verified-domain gate runs first, so an off-domain callback never
    // reads the stored ID token or the principal row.
    mockIdTokenClaims({ roles: ['admin'] })
    await callHandlerWith({
      email: 'james@quackback.io',
      ssoOidc: { autoProvisionRole: 'user', attributeMapping: mapping },
    })
    expect(mockAccountFindFirst).not.toHaveBeenCalled()
    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockTeamRoleGap).not.toHaveBeenCalled()
  })

  it('still applies the claim-mapped role to an email at the verified domain', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    mockIdTokenClaims({ roles: ['member'] })
    await callHandlerWith({
      ssoOidc: { autoProvisionRole: 'user', attributeMapping: mapping },
    })
    expect(mockSet).toHaveBeenCalledWith({ role: 'member' })
  })

  it('still gates the default-role fallback on the verified domain (no claim match)', async () => {
    mockFindFirst.mockResolvedValue({ role: 'user' })
    mockIdTokenClaims({ roles: ['guest'] })
    await callHandlerWith({
      email: 'james@quackback.io',
      ssoOidc: {
        autoProvisionRole: 'member',
        attributeMapping: {
          claimPath: 'roles',
          rules: [{ whenContains: 'admin', role: 'admin' }],
        },
      },
    })
    expect(mockSet).not.toHaveBeenCalled()
  })
})

describe('handleAutoProvisionAfter -- returning user whose principal was soft-removed', () => {
  it('recreates the principal with the claim-mapped role when no principal exists', async () => {
    // "Remove from portal" deletes the principal but keeps the auth user, so a
    // returning OIDC user has no principal when this hook runs. The resolved
    // role must still land — create the principal in-band rather than silently
    // updating zero rows (which would leave the lazy path to recreate 'user').
    // Venturi fork: the email is at the provider's verified domain (the
    // default alice@acme.com); an off-domain email is covered below.
    mockFindFirst.mockResolvedValue(undefined) // principal was soft-removed
    mockIdTokenClaims({ roles: ['member'] })
    await callHandlerWith({
      ssoOidc: {
        autoProvisionRole: 'user',
        attributeMapping: {
          claimPath: 'roles',
          rules: [{ whenContains: 'member', role: 'member' }],
        },
      },
    })
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ role: 'member' }))
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('recreates the principal with the default role for a returning user at a verified domain', async () => {
    // No claim match → default role; the email is at the provider's verified
    // domain (acme.com) so the fallback still provisions, and the missing
    // principal must be created, not updated.
    mockFindFirst.mockResolvedValue(undefined)
    mockIdTokenClaims({ roles: ['unmatched'] })
    await callHandlerWith({
      ssoOidc: {
        autoProvisionRole: 'member',
        attributeMapping: {
          claimPath: 'roles',
          rules: [{ whenContains: 'admin', role: 'admin' }],
        },
      },
    })
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ role: 'member' }))
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('does not provision a returning user with no claim match and no verified domain', async () => {
    // Boundary: the default-role fallback stays domain-scoped even for a
    // missing principal, so an off-domain user with no matching claim is left
    // untouched (the lazy path recreates them as a plain portal 'user').
    mockFindFirst.mockResolvedValue(undefined)
    mockIdTokenClaims({ roles: ['unmatched'] })
    await callHandlerWith({
      email: 'james@quackback.io',
      ssoOidc: {
        autoProvisionRole: 'member',
        attributeMapping: {
          claimPath: 'roles',
          rules: [{ whenContains: 'admin', role: 'admin' }],
        },
      },
    })
    expect(mockInsertValues).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('does not recreate an off-domain returning user with a claim-mapped team role (Venturi fork)', async () => {
    mockFindFirst.mockResolvedValue(undefined)
    mockIdTokenClaims({ roles: ['member'] })
    await callHandlerWith({
      email: 'james@quackback.io',
      ssoOidc: {
        autoProvisionRole: 'user',
        attributeMapping: {
          claimPath: 'roles',
          rules: [{ whenContains: 'member', role: 'member' }],
        },
      },
    })
    expect(mockInsertValues).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('does not recreate a returning user with a team role its identity cannot hold (Venturi fork)', async () => {
    // At the provider's verified domain, but the team identity rule refuses:
    // the principal is left for the lazy path to recreate as a plain 'user'.
    mockFindFirst.mockResolvedValue(undefined)
    mockTeamRoleGap.mockResolvedValue('email_domain')
    mockIdTokenClaims({ roles: ['member'] })
    await callHandlerWith({
      ssoOidc: {
        autoProvisionRole: 'user',
        attributeMapping: {
          claimPath: 'roles',
          rules: [{ whenContains: 'member', role: 'member' }],
        },
      },
    })
    expect(mockInsertValues).not.toHaveBeenCalled()
    expect(mockSet).not.toHaveBeenCalled()
  })
})
