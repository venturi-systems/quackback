/**
 * DEF-45: `GET /roadmap?board=<anything>` answered HTTP 500 and embedded the
 * raw zod issue ("Invalid input: expected array, received string") in the
 * page, because the route's validateSearch rejected a bare value and the
 * router turns a rejected search into a SearchParamError.
 *
 * These tests drive each route's real validateSearch the way the router does:
 * the query string goes through TanStack's own JSON-first parser, then through
 * the schema's Standard Schema `validate`, which is the call router-core makes.
 * A result carrying `issues` is exactly the case that became a 500. The
 * round-trip check covers the other half: on the server the router redirects
 * to the canonical URL built from the validated values, so that URL must
 * validate to the same values or the redirect would never settle.
 */
import { describe, expect, it, vi } from 'vitest'
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'

vi.mock('@/lib/client/queries/portal', () => ({ portalQueries: {} }))
vi.mock('@/lib/client/queries/admin', () => ({ adminQueries: {} }))
vi.mock('@/lib/client/queries/feedback', () => ({ feedbackQueries: {} }))
vi.mock('@/lib/client/hooks/use-portal-posts-query', () => ({
  votedPostsKeys: { byWorkspace: () => ['votedPosts'] },
}))
vi.mock('@/components/public/roadmap-board', () => ({ RoadmapBoard: () => null }))
vi.mock('@/components/admin/roadmap-admin', () => ({ RoadmapAdmin: () => null }))
vi.mock('@/components/admin/roadmap-modal', () => ({ RoadmapModal: () => null }))
vi.mock('@/components/admin/tab-strip', () => ({ TabStrip: () => null }))

type StandardResult = { value?: Record<string, unknown>; issues?: ReadonlyArray<unknown> }
type StandardSchema = { '~standard': { validate: (input: unknown) => StandardResult } }

function validatorOf(route: unknown): StandardSchema {
  const validator = (route as { options?: { validateSearch?: unknown } }).options?.validateSearch
  if (!validator || typeof validator !== 'object' || !('~standard' in validator)) {
    throw new Error('Route has no Standard Schema validateSearch')
  }
  return validator as StandardSchema
}

/** What the router's validateSearch does with the query string of a request. */
function validate(route: unknown, query: string): StandardResult {
  const result = validatorOf(route)['~standard'].validate(defaultParseSearch(query))
  if (result instanceof Promise) throw new Error('validateSearch must stay synchronous')
  return result
}

const { Route: portalRoadmap } = await import('../_portal/roadmap.index')
const { Route: portalHome } = await import('../_portal/index')
const { Route: adminFeedback } = await import('../admin/feedback')
const { Route: adminRoadmap } = await import('../admin/roadmap')

/** Query strings a person can type, paste or follow from another site. */
const HOSTILE_QUERIES = [
  '?board=feature-requests',
  '?board=123',
  '?board=true',
  '?board=',
  '?board=a&board=b',
  '?board=%7B%22a%22%3A1%7D',
  '?board=%5B%5B%22a%22%5D%5D',
  '?board=null',
  '?tags=x&segments=y&status=open&tagIds=t',
  '?search=123',
  '?search=%5B%22a%22%5D',
  '?roadmap=123&post=true&owner=null',
  '?sort=bogus',
  '?sort=123',
  '?minVotes=abc',
  '?minVotes=0',
  '?minVotes=5',
  '?dateFrom=yesterday',
  '?dateFrom=2026-02-31',
  '?responded=maybe',
  '?hasDuplicates=yes&deleted=1',
  '?suggestionSort=x&suggestionStatus=y',
]

const ROUTES: Array<[string, unknown]> = [
  ['/_portal/roadmap/', portalRoadmap],
  ['/_portal/', portalHome],
  ['/admin/feedback', adminFeedback],
  ['/admin/roadmap', adminRoadmap],
]

describe.each(ROUTES)('%s validateSearch', (_id, route) => {
  it.each(HOSTILE_QUERIES)('accepts %s without a validation error', (query) => {
    const result = validate(route, query)
    expect(result.issues).toBeUndefined()
  })

  it.each(HOSTILE_QUERIES)('settles the canonical redirect for %s', (query) => {
    const first = validate(route, query).value ?? {}
    const canonical = defaultStringifySearch(first)
    const second = validate(route, canonical).value ?? {}
    expect(second).toEqual(first)
  })
})

describe('DEF-45 normalization', () => {
  it('reads /roadmap?board=<slug> as a one-board filter', () => {
    expect(validate(portalRoadmap, '?board=feature-requests').value).toMatchObject({
      board: ['feature-requests'],
    })
    expect(validate(adminRoadmap, '?board=feature-requests').value).toMatchObject({
      board: ['feature-requests'],
    })
    expect(validate(adminFeedback, '?board=feature-requests').value).toMatchObject({
      board: ['feature-requests'],
    })
  })

  it('keeps the list form the app itself writes', () => {
    const query = `?${new URLSearchParams({ board: JSON.stringify(['a', 'b']) })}`
    expect(validate(portalRoadmap, query).value).toMatchObject({ board: ['a', 'b'] })
  })

  it('reads a malformed choice as the route default', () => {
    expect(validate(portalHome, '?sort=bogus').value).toMatchObject({ sort: 'trending' })
    expect(validate(adminFeedback, '?sort=bogus').value).toMatchObject({ sort: 'newest' })
    expect(validate(portalRoadmap, '?sort=bogus').value?.sort).toBeUndefined()
  })

  it('reads the portal home status filter from a bare value', () => {
    expect(validate(portalHome, '?status=open').value).toMatchObject({ status: ['open'] })
  })

  it('keeps a numeric search as the text that was typed', () => {
    expect(validate(portalRoadmap, '?search=123').value).toMatchObject({ search: '123' })
    expect(validate(portalHome, '?search=123').value).toMatchObject({ search: '123' })
  })

  it('drops an invalid minimum vote count instead of failing', () => {
    expect(validate(portalHome, '?minVotes=abc').value?.minVotes).toBeUndefined()
    expect(validate(portalHome, '?minVotes=5').value).toMatchObject({ minVotes: 5 })
  })
})
