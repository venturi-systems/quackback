import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { generateId } from '@quackback/ids'
import { MAX_SEARCH_COUNT, searchDate, searchDay, searchText } from '@/lib/shared/search-params'
import {
  fetchPortalDataSchema,
  fetchPublicPostsSchema,
  filterCount,
  filterDate,
  filterDay,
  filterId,
  filterText,
  inboxPostListSchema,
  listInboxPostsSchema,
  listPortalUsersSchema,
  listPublicPostsSchema,
  publicRoadmapPostListSchema,
  roadmapPostListSchema,
} from '../list-filters'

// DEF-45: the routes hold every filter to what the list queries accept, but a
// hand-made `/_serverFn/` request reaches these validators without the route.
// They must refuse what the query would fail on, and still take everything the
// routes pass on.

const NUL = '\u0000'

/** Date forms a URL can carry: some a route keeps, some it drops. */
const DATES = [
  '2026-01-31',
  '2026-01-31T10:00',
  '2026-01-31T10:00:00.000Z',
  '2026-01-31T10:00+05:30',
  '0001-01-02',
  '9999-12-30',
  '0000-01-01',
  '0001-01-01T00:00+01:00',
  '2026-13-45',
  '10000-01-01',
  'yesterday',
  '',
]

/** Whether `schema` accepts `value`. */
function accepts(schema: z.ZodType, value: unknown): boolean {
  return schema.safeParse(value).success
}

/** A labelled input for a table of refusals. */
type Case = [label: string, input: Record<string, unknown>]

describe('filter fields match the route helpers', () => {
  it('filterDate takes exactly the dates searchDate keeps', () => {
    const route = searchDate()
    for (const value of DATES) {
      expect(accepts(filterDate(), value), value).toBe(route.parse(value) !== undefined)
    }
  })

  it('filterDay takes exactly the dates searchDay keeps', () => {
    const route = searchDay()
    for (const value of DATES) {
      expect(accepts(filterDay(), value), value).toBe(route.parse(value) !== undefined)
    }
  })

  it('filterDate takes the ISO text a loader makes from a kept date', () => {
    for (const value of ['2026-01-31', '2026-01-31T10:00', '0001-01-02', '9999-12-30']) {
      expect(accepts(filterDate(), new Date(value).toISOString()), value).toBe(true)
    }
  })

  it('filterText takes exactly the text searchText keeps', () => {
    const route = searchText()
    for (const value of ['dark mode', '', 'a%00b', `a${NUL}b`, NUL]) {
      expect(accepts(filterText(), value), JSON.stringify(value)).toBe(
        route.parse(value) !== undefined
      )
    }
  })
})

describe('filter fields refuse what the query cannot take', () => {
  it('refuses a year Postgres rejects', () => {
    expect(accepts(filterDate(), '0000-01-01')).toBe(false)
    expect(accepts(filterDate(), '0001-01-01T00:00+01:00')).toBe(false)
    expect(accepts(filterDay(), '0000-01-01')).toBe(false)
  })

  it('refuses text that is not a date', () => {
    expect(accepts(filterDate(), '2026-13-45')).toBe(false)
    expect(accepts(filterDate(), 'yesterday')).toBe(false)
    expect(accepts(filterDay(), '2026-01-31T10:00')).toBe(false)
  })

  it('refuses a NUL character', () => {
    expect(accepts(filterText(), `dark${NUL}mode`)).toBe(false)
    expect(accepts(filterText(), 'dark mode')).toBe(true)
  })

  it('keeps only TypeIDs of the named entity', () => {
    expect(accepts(filterId('tag'), generateId('tag'))).toBe(true)
    const malformed = ['tag_foo', generateId('board'), 'unassigned', '', `${generateId('tag')}x`]
    for (const value of malformed) {
      expect(accepts(filterId('tag'), value), value).toBe(false)
    }
  })

  it('keeps only whole numbers an integer column can hold', () => {
    expect(accepts(filterCount(), 0)).toBe(true)
    expect(accepts(filterCount(), MAX_SEARCH_COUNT)).toBe(true)
    for (const value of [-1, 1.5, MAX_SEARCH_COUNT + 1, Number.NaN, Infinity, '5']) {
      expect(accepts(filterCount(), value), String(value)).toBe(false)
    }
    expect(accepts(filterCount(1), 0)).toBe(false)
  })
})

describe('portal feed inputs', () => {
  const tagId = generateId('tag')

  it("fetchPortalDataSchema takes the portal loader's filters", () => {
    const input = {
      boardSlug: 'ideas',
      search: 'dark mode',
      sort: 'trending' as const,
      statusSlugs: ['open', 'status_foo'],
      tagIds: [tagId],
      minVotes: 5,
      dateFrom: '2026-01-31',
      responded: 'responded' as const,
    }
    expect(fetchPortalDataSchema.parse(input)).toEqual(input)
  })

  it('fetchPortalDataSchema drops a user id instead of reading it', () => {
    expect(
      fetchPortalDataSchema.parse({ sort: 'top', userId: 'user_01h455vb4pex5vsknk084sn02q' })
    ).toEqual({ sort: 'top' })
  })

  it.each<Case>([
    ['a year Postgres rejects', { dateFrom: '0000-01-01' }],
    ['a timestamp where a day is expected', { dateFrom: '2026-01-31T10:00' }],
    ['a NUL in the search', { search: `a${NUL}b` }],
    ['a NUL in the board slug', { boardSlug: `a${NUL}b` }],
    ['a NUL in a status slug', { statusSlugs: [`a${NUL}b`] }],
    ['a tag id that is not a TypeID', { tagIds: ['tag_foo'] }],
    ['a vote count past the integer range', { minVotes: MAX_SEARCH_COUNT + 1 }],
  ])('fetchPortalDataSchema refuses %s', (_label, extra) => {
    expect(accepts(fetchPortalDataSchema, { sort: 'top', ...extra })).toBe(false)
  })

  it('fetchPublicPostsSchema refuses a NUL in its text', () => {
    expect(accepts(fetchPublicPostsSchema, { sort: 'top', boardSlug: 'ideas' })).toBe(true)
    expect(accepts(fetchPublicPostsSchema, { sort: 'top', search: `a${NUL}` })).toBe(false)
    expect(accepts(fetchPublicPostsSchema, { sort: 'top', boardSlug: `a${NUL}` })).toBe(false)
  })

  it('listPublicPostsSchema takes the feed and widget calls', () => {
    expect(listPublicPostsSchema.parse({})).toEqual({ sort: 'top', page: 1, limit: 20 })
    expect(
      accepts(listPublicPostsSchema, { sort: 'top', page: 2, limit: 20, boardSlug: 'ideas' })
    ).toBe(true)
    expect(
      accepts(listPublicPostsSchema, {
        search: 'dark mode',
        statusIds: [generateId('status')],
        statusSlugs: ['open', 'status_foo'],
        tagIds: [tagId],
        sort: 'new',
        cursor: 'eyJpZCI6InBvc3QifQ',
        limit: 20,
        minVotes: 1,
        dateFrom: '2026-01-31',
        responded: 'unresponded',
      })
    ).toBe(true)
  })

  it.each<Case>([
    ['a status id that is not a TypeID', { statusIds: ['status_foo'] }],
    ['a tag id that is not a TypeID', { tagIds: [generateId('board')] }],
    ['a year Postgres rejects', { dateFrom: '0000-01-01' }],
    ['a NUL in the search', { search: NUL }],
    ['page 0', { page: 0 }],
    ['a limit past 100', { limit: 101 }],
  ])('listPublicPostsSchema refuses %s', (_label, extra) => {
    expect(accepts(listPublicPostsSchema, extra)).toBe(false)
  })
})

describe('roadmap column inputs', () => {
  const roadmapId = generateId('roadmap')

  /** What the portal and admin roadmap columns send with every filter set. */
  const columnInput = {
    roadmapId,
    statusId: generateId('status'),
    limit: 20,
    offset: 40,
    search: 'dark mode',
    boardIds: [generateId('board')],
    tagIds: [generateId('tag')],
    segmentIds: [generateId('segment')],
    sort: 'votes' as const,
  }

  it.each<[name: string, schema: z.ZodType]>([
    ['fetchPublicRoadmapPosts', publicRoadmapPostListSchema],
    ['getRoadmapPostsFn', roadmapPostListSchema],
  ])('%s takes the column query with and without filters', (_name, schema) => {
    expect(accepts(schema, columnInput)).toBe(true)
    expect(accepts(schema, { roadmapId })).toBe(true)
  })

  it('getRoadmapPostsFn still fills the first page by default', () => {
    expect(roadmapPostListSchema.parse({ roadmapId })).toEqual({ roadmapId, limit: 20, offset: 0 })
  })

  it.each<Case>([
    ['a roadmap id that is not a TypeID', { roadmapId: 'roadmap_foo' }],
    ['a status slug where a status id is expected', { statusId: 'in-progress' }],
    ['a board slug where a board id is expected', { boardIds: ['ideas'] }],
    ['a tag id of another entity', { tagIds: [generateId('board')] }],
    ['a segment id that is not a TypeID', { segmentIds: ['vip'] }],
    ['a NUL in the search', { search: `dark${NUL}mode` }],
    ['a negative offset', { offset: -20 }],
    ['a fractional offset', { offset: 1.5 }],
    ['a limit past 100', { limit: 101 }],
  ])('both roadmap column schemas refuse %s', (_label, extra) => {
    expect(accepts(publicRoadmapPostListSchema, { roadmapId, ...extra })).toBe(false)
    expect(accepts(roadmapPostListSchema, { roadmapId, ...extra })).toBe(false)
  })
})

describe('admin inbox inputs', () => {
  const principalId = generateId('principal')

  /** What the inbox loader and list send for a full filter set. */
  const loaderInput = {
    boardIds: [generateId('board')],
    statusSlugs: ['open'],
    tagIds: [generateId('tag')],
    segmentIds: [generateId('segment')],
    ownerId: null,
    search: 'dark mode',
    dateFrom: '2026-01-01',
    dateTo: '2026-01-31T23:59:59.999Z',
    minVotes: 0,
    minComments: 3,
    hasDuplicates: true,
    responded: 'all' as const,
    updatedBefore: '2026-01-31T10:00',
    sort: 'votes' as const,
    showDeleted: true,
    limit: 20,
  }

  it.each<[name: string, schema: z.ZodType]>([
    ['fetchInboxPosts', inboxPostListSchema],
    ['fetchInboxPostsForAdmin', listInboxPostsSchema],
  ])('%s takes the loader filters, an owner id and a post cursor', (_name, schema) => {
    expect(accepts(schema, loaderInput)).toBe(true)
    expect(accepts(schema, { ...loaderInput, ownerId: principalId })).toBe(true)
    expect(accepts(schema, { cursor: generateId('post') })).toBe(true)
  })

  it.each<Case>([
    ['"unassigned" as an owner id', { ownerId: 'unassigned' }],
    ['a board id that is not a TypeID', { boardIds: ['ideas'] }],
    ['a segment id that is not a TypeID', { segmentIds: ['segment_foo'] }],
    ['a year Postgres rejects', { updatedBefore: '0000-01-01' }],
    ['a date Date cannot read', { dateTo: '2026-13-45' }],
    ['a NUL in the search', { search: `a${NUL}` }],
    ['a NUL in a status slug', { statusSlugs: [NUL] }],
    ['a fractional count', { minComments: 1.5 }],
    ['a negative count', { minVotes: -1 }],
    ['a cursor that is not a post id', { cursor: 'x' }],
    ['limit 0', { limit: 0 }],
    ['a limit past 100', { limit: 1000 }],
  ])('both inbox schemas refuse %s', (_label, extra) => {
    expect(accepts(inboxPostListSchema, extra)).toBe(false)
    expect(accepts(listInboxPostsSchema, extra)).toBe(false)
  })

  it('fetchInboxPostsForAdmin keeps only status TypeIDs', () => {
    expect(accepts(listInboxPostsSchema, { statusIds: [generateId('status')] })).toBe(true)
    expect(accepts(listInboxPostsSchema, { statusIds: ['open'] })).toBe(false)
  })
})

describe('admin users input', () => {
  it('takes what the users loader and list send', () => {
    expect(
      accepts(listPortalUsersSchema, {
        search: 'ann',
        verified: true,
        dateFrom: new Date('2026-01-01').toISOString(),
        dateTo: new Date('2026-01-31T10:00').toISOString(),
        sort: 'newest',
        page: 1,
        limit: 20,
        segmentIds: [generateId('segment')],
      })
    ).toBe(true)
    expect(
      accepts(listPortalUsersSchema, {
        emailDomain: 'example.com',
        postCount: { op: 'gte', value: 5 },
        voteCount: { op: 'eq', value: 0 },
        commentCount: { op: 'lt', value: MAX_SEARCH_COUNT },
        customAttrs: [
          { key: 'plan', op: 'eq', value: 'pro' },
          { key: 'seats', op: 'gte', value: '5' },
          { key: 'plan', op: 'unknown', value: '' },
        ],
        includeAnonymous: true,
        page: 3,
        limit: 20,
      })
    ).toBe(true)
    expect(accepts(listPortalUsersSchema, { sort: 'newest', page: 1, limit: 1 })).toBe(true)
  })

  it.each<Case>([
    ['a fractional activity count', { postCount: { op: 'gt', value: 1.5 } }],
    ['an activity count past the integer range', { voteCount: { op: 'gt', value: 2 ** 31 } }],
    ['an unknown activity operator', { commentCount: { op: 'between', value: 1 } }],
    ['a NUL in a custom attribute key', { customAttrs: [{ key: NUL, op: 'eq', value: 'x' }] }],
    ['a NUL in a custom attribute value', { customAttrs: [{ key: 'k', op: 'eq', value: NUL }] }],
    ['a NUL in the email domain', { emailDomain: `a${NUL}` }],
    ['a year Postgres rejects', { dateFrom: '0001-01-01T00:00+01:00' }],
    ['a segment id that is not a TypeID', { segmentIds: ['vip'] }],
    ['page 0', { page: 0 }],
    ['a negative limit', { limit: -1 }],
  ])('refuses %s', (_label, extra) => {
    expect(accepts(listPortalUsersSchema, extra)).toBe(false)
  })
})
