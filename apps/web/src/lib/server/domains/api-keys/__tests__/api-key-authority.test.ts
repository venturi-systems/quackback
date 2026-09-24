/**
 * An API key exercises the lower of its stored role and its creator's current
 * role under the team identity rule, so a key minted by an account that no
 * longer qualifies (for example the password bootstrap administrator) loses
 * its authority with the account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  creator: undefined as undefined | Record<string, unknown>,
  creatorRole: 'admin' as string,
}))

vi.mock('@/lib/server/db', () => ({
  db: { query: { principal: { findFirst: async () => hoisted.creator } } },
  principal: { id: 'principal.id' },
  eq: () => ({}),
}))

vi.mock('@/lib/server/domains/principals/team-identity', () => ({
  resolveTeamRole: async () => hoisted.creatorRole,
}))

const { resolveApiKeyRole, lowerRole } = await import('../api-key-authority')

beforeEach(() => {
  hoisted.creator = { id: 'principal_creator', role: 'admin', type: 'user', userId: 'user_c' }
  hoisted.creatorRole = 'admin'
})

describe('lowerRole', () => {
  it('picks the less privileged role', () => {
    expect(lowerRole('admin', 'member')).toBe('member')
    expect(lowerRole('member', 'admin')).toBe('member')
    expect(lowerRole('admin', 'user')).toBe('user')
  })
})

describe('resolveApiKeyRole', () => {
  const key = { createdById: 'principal_creator' as never }

  it('keeps an admin key whose creator is still a qualifying admin', async () => {
    expect(await resolveApiKeyRole(key, 'admin')).toBe('admin')
  })

  it('caps an admin key at its creator’s current role', async () => {
    hoisted.creatorRole = 'member'
    expect(await resolveApiKeyRole(key, 'admin')).toBe('member')
  })

  it('strips a key minted by an account that no longer qualifies', async () => {
    hoisted.creatorRole = 'user'
    expect(await resolveApiKeyRole(key, 'admin')).toBe('user')
  })

  it('strips a key whose creator is gone', async () => {
    expect(await resolveApiKeyRole({ createdById: null }, 'admin')).toBe('user')
    hoisted.creator = undefined
    expect(await resolveApiKeyRole(key, 'admin')).toBe('user')
  })

  it('never raises a revoked or contributor key', async () => {
    expect(await resolveApiKeyRole(key, 'user')).toBe('user')
    expect(await resolveApiKeyRole(key, null)).toBe('user')
  })
})
