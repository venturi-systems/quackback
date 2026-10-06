// FB-019: current individual or exact-domain approval is required for private feedback.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  person: vi.fn(),
  principal: vi.fn(),
  role: vi.fn(),
  approvals: vi.fn(),
  revoke: vi.fn(),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getPortalConfig: mocks.config,
}))
vi.mock('@/lib/server/domains/principals/session-role', () => ({
  resolveSessionRole: mocks.role,
}))
vi.mock('@/lib/server/db', () => ({
  db: {
    query: {
      user: { findFirst: mocks.person },
      principal: { findFirst: mocks.principal },
      invitation: { findMany: mocks.approvals },
    },
    delete: () => ({ where: mocks.revoke }),
  },
  user: { id: 'userId' },
  principal: { userId: 'userId' },
  invitation: { email: 'email', kind: 'kind', status: 'status' },
  session: { userId: 'userId' },
  eq: (column: unknown, value: unknown) => ({ column, value }),
  and: (...values: unknown[]) => values,
  inArray: (column: unknown, values: unknown[]) => ({ column, values }),
}))

import {
  assertPortalContentAdmission,
  assertPortalSessionAdmission,
  hasPortalSessionAdmission,
} from '../portal-admission'
import { matchesApprovedPortalDomain } from '@/lib/server/domains/settings/portal-access'

const person = {
  id: 'user_01',
  email: 'avery@acme.example',
  emailVerified: true,
  isAnonymous: false,
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.config.mockResolvedValue({ access: { visibility: 'private', allowedDomains: [] } })
  mocks.person.mockResolvedValue({ ...person })
  mocks.principal.mockResolvedValue({
    id: 'principal_01',
    userId: person.id,
    type: 'user',
    role: 'user',
  })
  mocks.role.mockResolvedValue('user')
  mocks.approvals.mockResolvedValue([])
  mocks.revoke.mockResolvedValue(undefined)
})

describe('FB-019 approved feedback admission', () => {
  it('denies an authenticated identity with no administrator approval', async () => {
    expect(await hasPortalSessionAdmission(person.id)).toBe(false)
    await expect(assertPortalSessionAdmission(person.id)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
    expect(mocks.revoke).toHaveBeenCalledWith({ column: 'userId', value: person.id })
  })
  it('accepts a verified exact domain with normalized casing and whitespace', async () => {
    mocks.person.mockResolvedValue({ ...person, email: ' Avery@Acme.Example ' })
    mocks.config.mockResolvedValue({
      access: { visibility: 'private', allowedDomains: [' ACME.EXAMPLE '] },
    })
    await expect(assertPortalSessionAdmission(person.id)).resolves.toBeUndefined()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it.each(['avery@sub.acme.example', 'avery@evilacme.example', 'avery@acme.example.evil'])(
    'denies lookalike or descendant domain %s',
    async (email) => {
      mocks.person.mockResolvedValue({ ...person, email })
      mocks.config.mockResolvedValue({
        access: { visibility: 'private', allowedDomains: ['acme.example'] },
      })
      expect(await hasPortalSessionAdmission(person.id)).toBe(false)
    }
  )
  it('does not trust an unverified approved domain or anonymous identity', async () => {
    mocks.config.mockResolvedValue({
      access: { visibility: 'private', allowedDomains: ['acme.example'] },
    })
    mocks.person.mockResolvedValue({ ...person, emailVerified: false })
    expect(await hasPortalSessionAdmission(person.id)).toBe(false)
    mocks.person.mockResolvedValue({ ...person, isAnonymous: true })
    expect(await hasPortalSessionAdmission(person.id)).toBe(false)
  })
  it.each(['admin', 'member'])('preserves effective team %s access', async (role) => {
    mocks.role.mockResolvedValue(role)
    expect(await hasPortalSessionAdmission(person.id)).toBe(true)
  })
  it('does not trust a stored admin role that no longer has an eligible team identity', async () => {
    mocks.principal.mockResolvedValue({
      id: 'principal_01',
      userId: person.id,
      type: 'user',
      role: 'admin',
    })
    mocks.role.mockResolvedValue('user')
    expect(await hasPortalSessionAdmission(person.id)).toBe(false)
  })
  it('does not admit a service principal with a stored team role', async () => {
    mocks.principal.mockResolvedValue({ type: 'service', role: 'admin' })
    mocks.role.mockResolvedValue('admin')
    expect(await hasPortalSessionAdmission(person.id)).toBe(false)
    expect(mocks.role).not.toHaveBeenCalled()
  })
  it('admits an accepted individual approval after its invitation expiry', async () => {
    mocks.approvals.mockResolvedValue([
      { kind: 'portal', status: 'accepted', expiresAt: new Date(0) },
    ])
    expect(await hasPortalSessionAdmission(person.id)).toBe(true)
  })
  it('allows first sign-in for an unexpired administrator invitation', async () => {
    mocks.approvals.mockResolvedValue([
      { kind: 'portal', status: 'pending', expiresAt: new Date(Date.now() + 60_000) },
    ])
    expect(await hasPortalSessionAdmission(person.id)).toBe(true)
    expect(mocks.approvals).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.arrayContaining([
          { column: 'email', value: person.email },
          { column: 'kind', values: ['portal', 'team'] },
          { column: 'status', values: ['accepted', 'pending'] },
        ]),
      })
    )
  })
  it.each(['pending', 'canceled', 'expired', 'rejected'])(
    'rejects expired or revoked individual approval (%s)',
    async (status) => {
      mocks.approvals.mockResolvedValue([{ status, expiresAt: new Date(0) }])
      expect(await hasPortalSessionAdmission(person.id)).toBe(false)
    }
  )
  it('rechecks domain removal on the next request and revokes old sessions', async () => {
    mocks.config.mockResolvedValueOnce({
      access: { visibility: 'private', allowedDomains: ['acme.example'] },
    })
    await assertPortalSessionAdmission(person.id)
    await expect(assertPortalSessionAdmission(person.id)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
    expect(mocks.revoke).toHaveBeenCalledTimes(1)
  })
  it('keeps a pending invite session for acceptance but denies protected content', async () => {
    mocks.approvals.mockResolvedValue([
      { kind: 'portal', status: 'pending', expiresAt: new Date(Date.now() + 60_000) },
    ])
    await expect(assertPortalSessionAdmission(person.id)).resolves.toBeUndefined()
    await expect(assertPortalContentAdmission(person.id)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('does not preserve a removed team membership through its historical invitation', async () => {
    mocks.approvals.mockResolvedValue([
      { kind: 'team', status: 'accepted', expiresAt: new Date(0) },
    ])
    await expect(assertPortalSessionAdmission(person.id)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
    expect(mocks.revoke).toHaveBeenCalledTimes(1)
  })
  it('permits first sign-in to accept a pending team invitation', async () => {
    mocks.approvals.mockResolvedValue([
      { kind: 'team', status: 'pending', expiresAt: new Date(Date.now() + 60_000) },
    ])
    await expect(assertPortalSessionAdmission(person.id)).resolves.toBeUndefined()
    await expect(assertPortalContentAdmission(person.id)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
  })
  it('denies a policy outage without revoking otherwise approved sessions', async () => {
    mocks.config.mockRejectedValue(new Error('database unavailable'))
    await expect(assertPortalSessionAdmission(person.id)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('fails closed even when session deletion is unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.revoke.mockRejectedValue(new Error('database unavailable'))
    await expect(assertPortalSessionAdmission(person.id)).rejects.toMatchObject({
      status: 'FORBIDDEN',
    })
    error.mockRestore()
  })
})

describe('exact approved domain boundary', () => {
  it('supports a multi-part company domain without suffix or subdomain grants', () => {
    expect(matchesApprovedPortalDomain('avery@company.co.uk', ['company.co.uk'])).toBe(true)
    expect(matchesApprovedPortalDomain('avery@sub.company.co.uk', ['company.co.uk'])).toBe(false)
    expect(matchesApprovedPortalDomain('avery@company.co.uk.evil', ['company.co.uk'])).toBe(false)
  })
  it.each(['avery@@acme.example', '@acme.example', 'avery@', 'avery x@acme.example'])(
    'rejects malformed identities %s',
    (email) => {
      expect(matchesApprovedPortalDomain(email, ['acme.example'])).toBe(false)
    }
  )
})
