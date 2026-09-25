import { z } from 'zod'
import { isValidTypeId, type IdPrefix } from '@quackback/ids'
import { MAX_SEARCH_COUNT, isSearchDate, isSearchDay } from '@/lib/shared/search-params'

/**
 * Input schemas for the server functions that list posts, roadmap columns and
 * portal users, and the field helpers other server-function inputs use.
 *
 * The routes that call these functions already hold every filter to what the
 * list queries accept (lib/shared/search-params.ts), so the app's own calls
 * never carry anything else. A server function is still an endpoint of its
 * own: a hand-made `/_serverFn/` request skips the route and reaches the
 * validator directly. These schemas therefore refuse, as a validation error,
 * every value the query would fail on (DEF-45):
 *
 * - text holding a NUL character, which Postgres rejects in any text;
 * - an id that is not a TypeID of its entity, which the id column throws on;
 * - a date `Date` cannot read, or whose UTC year is outside 1 to 9999;
 * - a count, page or limit that is not a whole number the query can take.
 *
 * Each field accepts everything the matching route helper keeps, so a value a
 * route passes on is never refused here.
 */

/** Text a query can take: any text without a NUL character. */
export function filterText() {
  return z.string().refine((value) => !value.includes('\u0000'), 'Text must not contain NUL')
}

/** An ISO date or timestamp whose instant falls in years 1 to 9999 (UTC). */
export function filterDate() {
  return z.string().refine(isSearchDate, 'Expected an ISO date in years 1 to 9999')
}

/** A calendar date without a time (`2026-01-31`) in years 1 to 9999. */
export function filterDay() {
  return z.string().refine(isSearchDay, 'Expected a calendar date in years 1 to 9999')
}

/** A TypeID of this entity, the only id form the app writes. */
export function filterId(prefix: IdPrefix) {
  return z.string().refine((value) => isValidTypeId(value, prefix), `Expected a ${prefix} id`)
}

/** A list of TypeIDs of this entity. */
export function filterIdList(prefix: IdPrefix) {
  return z.array(filterId(prefix))
}

/** A whole number from `min` up to what a Postgres `integer` can hold. */
export function filterCount(min = 0) {
  return z.number().int().min(min).max(MAX_SEARCH_COUNT)
}

/** A page size from 1 up to `max` rows. */
export function filterLimit(max = 100) {
  return z.number().int().min(1).max(max)
}

/**
 * A row offset: a whole number from 0. zod caps an int at the largest safe
 * integer, which a Postgres `OFFSET` (bigint) takes.
 */
export function filterOffset() {
  return z.number().int().min(0)
}

/** A page size the list queries serve. */
const pageLimit = filterLimit()

const portalSort = z.enum(['top', 'new', 'trending'])
const inboxSort = z.enum(['newest', 'oldest', 'votes'])

// ============================================
// Portal feed (lib/server/functions/portal.ts)
// ============================================

/** fetchPublicPosts */
export const fetchPublicPostsSchema = z.object({
  boardSlug: filterText().optional(),
  search: filterText().optional(),
  sort: portalSort,
})

/**
 * fetchPortalData. It takes no user id: the votes and principal it returns are
 * always the signed-in caller's, read from the session. The client still keys
 * its cache by the viewer, but never sends that key.
 */
export const fetchPortalDataSchema = z.object({
  boardSlug: filterText().optional(),
  search: filterText().optional(),
  sort: portalSort,
  statusSlugs: z.array(filterText()).optional(),
  tagIds: filterIdList('tag').optional(),
  minVotes: filterCount(1).optional(),
  dateFrom: filterDay().optional(),
  responded: z.enum(['responded', 'unresponded']).optional(),
})

// ============================================
// Portal and widget list (lib/server/functions/public-posts.ts)
// ============================================

/** listPublicPostsFn */
export const listPublicPostsSchema = z.object({
  boardSlug: filterText().optional(),
  search: filterText().optional(),
  statusIds: filterIdList('status').optional(),
  statusSlugs: z.array(filterText()).optional(),
  tagIds: filterIdList('tag').optional(),
  sort: portalSort.optional().default('top'),
  page: filterCount(1).optional().default(1),
  // A newest-feed cursor; decodePublicPostCursor checks its encoding.
  cursor: z.string().max(512).nullable().optional(),
  limit: pageLimit.optional().default(20),
  minVotes: filterCount(1).optional(),
  dateFrom: filterDay().optional(),
  responded: z.enum(['responded', 'unresponded']).optional(),
})

// ============================================
// Roadmap columns (lib/server/functions/portal.ts and roadmaps.ts)
// ============================================

/** The row offset of a roadmap column page. */
const rowOffset = filterOffset()

/** The filters the portal and admin roadmap columns share. */
const roadmapPostFilters = {
  roadmapId: filterId('roadmap'),
  statusId: filterId('status').optional(),
  search: filterText().optional(),
  boardIds: filterIdList('board').optional(),
  tagIds: filterIdList('tag').optional(),
  segmentIds: filterIdList('segment').optional(),
  sort: z.enum(['votes', 'newest', 'oldest']).optional(),
}

/** fetchPublicRoadmapPosts, the portal roadmap's column query. */
export const publicRoadmapPostListSchema = z.object({
  ...roadmapPostFilters,
  limit: pageLimit.optional(),
  offset: rowOffset.optional(),
})

/** getRoadmapPostsFn, the admin roadmap's column query. */
export const roadmapPostListSchema = z.object({
  ...roadmapPostFilters,
  limit: pageLimit.default(20),
  offset: rowOffset.default(0),
})

// ============================================
// Admin inbox (lib/server/functions/admin.ts and posts.ts)
// ============================================

/** The inbox filters both admin inbox functions share. */
const inboxFilters = {
  boardIds: filterIdList('board').optional(),
  statusSlugs: z.array(filterText()).optional(),
  tagIds: filterIdList('tag').optional(),
  segmentIds: filterIdList('segment').optional(),
  // null selects posts with no owner (the "Unassigned" filter).
  ownerId: filterId('principal').nullable().optional(),
  search: filterText().optional(),
  dateFrom: filterDate().optional(),
  dateTo: filterDate().optional(),
  minVotes: filterCount().optional(),
  minComments: filterCount().optional(),
  hasDuplicates: z.boolean().optional(),
  responded: z.enum(['all', 'responded', 'unresponded']).optional(),
  updatedBefore: filterDate().optional(),
  showDeleted: z.boolean().optional(),
  // The id of the last post on the previous page.
  cursor: filterId('post').optional(),
}

/** fetchInboxPosts (admin.ts), the inbox loader's query. */
export const inboxPostListSchema = z.object({
  ...inboxFilters,
  sort: inboxSort.default('newest'),
  limit: pageLimit.default(20),
})

/** fetchInboxPostsForAdmin (posts.ts), the inbox list's infinite query. */
export const listInboxPostsSchema = z.object({
  ...inboxFilters,
  statusIds: filterIdList('status').optional(),
  sort: inboxSort.optional().default('newest'),
  limit: pageLimit.optional().default(20),
})

// ============================================
// Admin users (lib/server/functions/admin.ts)
// ============================================

/** An activity count threshold: `{ op: 'gte', value: 5 }`. */
const activityCountFilterSchema = z.object({
  op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
  value: filterCount(),
})

/**
 * A custom attribute filter. The operator stays open text: the list query
 * ignores one it does not know, and the users page passes any operator it reads
 * from the URL.
 */
const customAttrFilterSchema = z.object({
  key: filterText(),
  op: filterText(),
  value: filterText(),
})

/** listPortalUsersFn */
export const listPortalUsersSchema = z.object({
  search: filterText().optional(),
  verified: z.boolean().optional(),
  dateFrom: filterDate().optional(),
  dateTo: filterDate().optional(),
  emailDomain: filterText().optional(),
  postCount: activityCountFilterSchema.optional(),
  voteCount: activityCountFilterSchema.optional(),
  commentCount: activityCountFilterSchema.optional(),
  customAttrs: z.array(customAttrFilterSchema).optional(),
  sort: z
    .enum(['newest', 'oldest', 'most_active', 'most_posts', 'most_comments', 'most_votes', 'name'])
    .optional(),
  page: filterCount(1).optional(),
  limit: pageLimit.optional(),
  segmentIds: filterIdList('segment').optional(),
  includeAnonymous: z.boolean().optional(),
})
