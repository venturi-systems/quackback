import { describe, expect, it } from 'vitest'
import {
  SITE_TITLE,
  gateHead,
  portalGateHead,
  portalGateOf,
  statusPageTitle,
  statusTitle,
  type HeadMatch,
} from '../route-head'

/**
 * DEF-44: a not-found page kept the site title in the server-rendered head
 * (only a client effect renamed the tab after hydration), and a gated portal
 * page such as `/roadmap` rendered the sign-in gate under "Roadmap - …" with
 * a canonical link. These helpers are what the root, `_portal` and portal
 * child heads call while the server renders.
 */

const GATE = { type: 'portal-access-gate', workspaceName: 'Venturi' }

function portal(loaderData: unknown, extra: Partial<HeadMatch> = {}): HeadMatch {
  return { routeId: '/_portal', status: 'success', loaderData, ...extra }
}

const ROOT: HeadMatch = { routeId: '__root__', status: 'success' }

describe('statusPageTitle', () => {
  it('is null for an ordinary page', () => {
    expect(statusPageTitle([ROOT, portal({ gate: null })])).toBeNull()
    expect(statusPageTitle([])).toBeNull()
  })

  it('names a page whose loader threw notFound()', () => {
    const board: HeadMatch = { routeId: '/_portal/b/$slug', status: 'notFound' }
    expect(statusPageTitle([ROOT, portal({ gate: null }), board])).toBe(
      'Page not found · Venturi Feedback'
    )
  })

  it('names a URL no route matches, which marks its boundary match _notFound', () => {
    expect(statusPageTitle([{ ...ROOT, _notFound: true }])).toBe(
      'Page not found · Venturi Feedback'
    )
  })

  it('names a page whose loading failed', () => {
    expect(statusPageTitle([ROOT, portal({}, { status: 'error' })])).toBe(
      'Page could not load · Venturi Feedback'
    )
  })

  it('matches the titles the status pages set after hydration', () => {
    // components/shared/error-page.tsx sets `${title} · Venturi Feedback`.
    expect(statusTitle('Page not found')).toBe(`Page not found · ${SITE_TITLE}`)
    expect(SITE_TITLE).toBe('Venturi Feedback')
  })
})

describe('portalGateOf and portalGateHead', () => {
  it('find the gate the _portal loader returned', () => {
    expect(portalGateOf([ROOT, portal({ gate: GATE })])).toEqual(GATE)
  })

  it('are null when the portal is open, not loaded, or not matched', () => {
    expect(portalGateOf([ROOT, portal({ gate: null })])).toBeNull()
    expect(portalGateOf([ROOT, portal(undefined)])).toBeNull()
    expect(portalGateOf([ROOT, { routeId: '/admin', loaderData: { gate: GATE } }])).toBeNull()
    expect(portalGateHead([ROOT, portal({ gate: null })])).toBeNull()
  })

  it('give a gated page the sign-in title and keep it out of search indexes', () => {
    expect(portalGateHead([ROOT, portal({ gate: GATE })])).toEqual({
      meta: [{ title: 'Sign in · Venturi' }, { name: 'robots', content: 'noindex, nofollow' }],
    })
  })

  it('carry no canonical link or description for the page behind the gate', () => {
    const head = portalGateHead([ROOT, portal({ gate: GATE })])
    expect(head).not.toHaveProperty('links')
    expect(head?.meta.some((m) => m.name === 'description')).toBe(false)
  })
})

describe('gateHead', () => {
  it('falls back to the company name when the workspace has none', () => {
    expect(gateHead({ workspaceName: '' }).meta[0]).toEqual({ title: 'Sign in · Venturi' })
  })
})
