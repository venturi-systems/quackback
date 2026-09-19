import { describe, it, expect } from 'vitest'
import { buildNavItems } from '../portal-header-nav'

describe('buildNavItems', () => {
  it('returns feedback/roadmap/changelog when help center is disabled', () => {
    const items = buildNavItems({ helpCenterEnabled: false, supportEnabled: false })
    expect(items.map((i) => i.to)).toEqual(['/', '/roadmap', '/changelog'])
  })

  it('adds Help tab when help center is enabled', () => {
    const items = buildNavItems({ helpCenterEnabled: true, supportEnabled: false })
    expect(items.map((i) => i.to)).toEqual(['/', '/roadmap', '/changelog', '/hc'])
  })

  it('adds Support tab when portal support is enabled', () => {
    const items = buildNavItems({ helpCenterEnabled: false, supportEnabled: true })
    expect(items.map((i) => i.to)).toEqual(['/', '/roadmap', '/changelog', '/support'])
  })

  it('orders Help before Support when both are enabled', () => {
    const items = buildNavItems({ helpCenterEnabled: true, supportEnabled: true })
    expect(items.map((i) => i.to)).toEqual(['/', '/roadmap', '/changelog', '/hc', '/support'])
  })
})
