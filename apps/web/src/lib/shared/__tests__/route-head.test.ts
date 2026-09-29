import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SITE_TITLE,
  SOCIAL_CARD_ALT,
  SOCIAL_CARD_URL,
  gateHead,
  portalGateHead,
  portalGateOf,
  socialCardMeta,
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

describe('socialCardMeta', () => {
  it('names the Venturi social card for this host as a large 1200 x 630 image', () => {
    expect(SOCIAL_CARD_URL).toBe('https://venturi.systems/og-image-feedback.png')
    expect(socialCardMeta()).toEqual([
      { property: 'og:image', content: SOCIAL_CARD_URL },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: SOCIAL_CARD_ALT },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:image', content: SOCIAL_CARD_URL },
      { name: 'twitter:image:alt', content: SOCIAL_CARD_ALT },
    ])
  })

  it('is the only preview image and card type the routes name', () => {
    // The portal and help center heads named the workspace logo, an SVG that
    // link previews do not show, so a shared portal link carried no image.
    const routes = fileURLToPath(new URL('../../../routes/', import.meta.url))
    const naming = readdirSync(routes, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file))
      .filter((file) =>
        /og:image|twitter:image|twitter:card/.test(readFileSync(join(routes, file), 'utf8'))
      )
    expect(naming).toEqual([])
  })
})
