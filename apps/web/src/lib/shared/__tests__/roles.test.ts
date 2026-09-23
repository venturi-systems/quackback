import { describe, it, expect } from 'vitest'
import { isTeamMember, isAdmin, effectiveRole } from '../roles'

describe('isTeamMember', () => {
  it('returns true for admin', () => {
    expect(isTeamMember('admin')).toBe(true)
  })

  it('returns true for member', () => {
    expect(isTeamMember('member')).toBe(true)
  })

  it('returns false for other strings', () => {
    expect(isTeamMember('viewer')).toBe(false)
    expect(isTeamMember('user')).toBe(false)
    expect(isTeamMember('')).toBe(false)
  })

  it('returns false for null', () => {
    expect(isTeamMember(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isTeamMember(undefined)).toBe(false)
  })
})

describe('isAdmin', () => {
  it('returns true for admin', () => {
    expect(isAdmin('admin')).toBe(true)
  })

  it('returns false for member', () => {
    expect(isAdmin('member')).toBe(false)
  })

  it('returns false for other strings', () => {
    expect(isAdmin('viewer')).toBe(false)
    expect(isAdmin('user')).toBe(false)
    expect(isAdmin('')).toBe(false)
  })

  it('returns false for null', () => {
    expect(isAdmin(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isAdmin(undefined)).toBe(false)
  })
})

describe('effectiveRole', () => {
  it('keeps team roles for human principals', () => {
    expect(effectiveRole('admin', 'user')).toBe('admin')
    expect(effectiveRole('member', 'user')).toBe('member')
    expect(effectiveRole('user', 'user')).toBe('user')
  })

  it('caps a team role held by an anonymous principal at user', () => {
    expect(effectiveRole('admin', 'anonymous')).toBe('user')
    expect(effectiveRole('member', 'anonymous')).toBe('user')
  })

  it('caps a team role held by a service principal or an unknown type at user', () => {
    expect(effectiveRole('admin', 'service')).toBe('user')
    expect(effectiveRole('member', null)).toBe('user')
    expect(effectiveRole('admin', undefined)).toBe('user')
  })

  it('leaves the user role unchanged for any principal type', () => {
    expect(effectiveRole('user', 'anonymous')).toBe('user')
  })

  it('returns null for unrecognised roles', () => {
    expect(effectiveRole('owner', 'user')).toBeNull()
    expect(effectiveRole(null, 'user')).toBeNull()
  })
})
