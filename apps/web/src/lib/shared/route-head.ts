import type { PortalAccessGateError } from '@/lib/shared/types/portal-gate-error'

/**
 * Server-rendered `<head>` titles for pages whose title does not come from
 * their own content: status pages and the portal sign-in gate.
 *
 * TanStack Router builds the head from every matched route in order, and the
 * last match that sets a title wins. Two titles went wrong that way (DEF-44):
 *
 * - A not-found or error page kept the site title in the server-rendered
 *   HTML. Only a client effect renamed the tab after hydration, so crawlers,
 *   link previews and anyone reading the raw response saw "Venturi Feedback".
 * - The sign-in gate set "Sign in · …" on the `_portal` layout, and then a
 *   child page such as `/roadmap` replaced it with "Roadmap - …", its own
 *   description and a canonical link, on a response that shows only the gate.
 *
 * The root and `_portal` heads read the status from the matches, and every
 * `_portal` child with its own head returns the gate head first.
 */

/** The site name that status titles end with. */
export const SITE_TITLE = 'Venturi Feedback'

/** A status page title, for example `Page not found · Venturi Feedback`. */
export function statusTitle(condition: string): string {
  return `${condition} · ${SITE_TITLE}`
}

/** The fields of a route match these helpers read. */
export interface HeadMatch {
  routeId: string
  status?: string
  _notFound?: boolean
  loaderData?: unknown
}

/** One head `meta` entry as these helpers build it. */
export interface HeadMeta {
  title?: string
  name?: string
  content?: string
}

/**
 * The title of the status page this request renders, or null for an ordinary
 * page. A route that throws `notFound()` leaves its match with status
 * `notFound`; a URL that no route matches marks its boundary match
 * `_notFound`; a route whose loading threw leaves status `error`.
 */
export function statusPageTitle(matches: ReadonlyArray<HeadMatch>): string | null {
  if (matches.some((match) => match.status === 'notFound' || match._notFound === true)) {
    return statusTitle('Page not found')
  }
  if (matches.some((match) => match.status === 'error')) {
    return statusTitle('Page could not load')
  }
  return null
}

/** The sign-in gate the `_portal` loader returned for this request, or null. */
export function portalGateOf(matches: ReadonlyArray<HeadMatch>): PortalAccessGateError | null {
  const portal = matches.find((match) => match.routeId === '/_portal')
  const data = portal?.loaderData as { gate?: PortalAccessGateError | null } | undefined
  return data?.gate ?? null
}

/** Head tags for the sign-in gate: a sign-in title, kept out of search indexes. */
export function gateHead(gate: Pick<PortalAccessGateError, 'workspaceName'>): {
  meta: HeadMeta[]
} {
  return {
    meta: [
      { title: `Sign in · ${gate.workspaceName || 'Venturi'}` },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }
}

/**
 * The gate head when this request renders the sign-in gate, else null. A
 * `_portal` child page calls this first in its own `head`, so its title,
 * description and canonical link never describe a page the visitor cannot see.
 */
export function portalGateHead(matches: ReadonlyArray<HeadMatch>): { meta: HeadMeta[] } | null {
  const gate = portalGateOf(matches)
  return gate ? gateHead(gate) : null
}
