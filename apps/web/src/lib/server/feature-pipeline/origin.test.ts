import { describe, it, expect } from 'vitest'
import { classifyOrigin } from './origin'
describe('request origin, independent of recorder', () => {
  it('keeps a customer request external when an admin records it', () => {
    expect(
      classifyOrigin({
        authorRole: 'user',
        authorType: 'user',
        callerIsStaff: true,
        declaredOrigin: 'internal',
      }).classification
    ).toBe('feature request')
  })
  it('does not invent external provenance for a service without an actor', () => {
    expect(
      classifyOrigin({ authorRole: 'user', authorType: 'service', callerIsStaff: false })
        .classification
    ).toBe('enhancement')
  })
  it('requires evidence when staff attest an external request in their own name', () => {
    expect(() =>
      classifyOrigin({
        authorRole: 'admin',
        authorType: 'user',
        callerIsStaff: true,
        declaredOrigin: 'external',
      })
    ).toThrow()
    expect(
      classifyOrigin({
        authorRole: 'admin',
        authorType: 'user',
        callerIsStaff: true,
        declaredOrigin: 'external',
        evidence: 'Customer call source ABC',
      }).classification
    ).toBe('feature request')
  })
  it('refuses a customer-controlled internal classification override', () => {
    expect(() =>
      classifyOrigin({
        authorRole: 'user',
        authorType: 'user',
        callerIsStaff: false,
        declaredOrigin: 'internal',
      })
    ).toThrow()
  })
})
