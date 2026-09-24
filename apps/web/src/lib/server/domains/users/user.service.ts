/**
 * UserService - Business logic for portal user management
 *
 * Provides operations for listing and managing portal users (role='user' in principal table).
 * Portal users are authenticated users who can vote/comment on the public portal
 * but don't have admin access (unlike admin/member roles).
 *
 * All users (team + portal) are unified in the principal table with roles:
 * - admin/member: Team members with admin dashboard access
 * - user: Portal users with public portal access only
 */

import {
  db,
  eq,
  and,
  or,
  ilike,
  inArray,
  isNull,
  desc,
  asc,
  sql,
  principal,
  user,
  posts,
  comments,
  votes,
  userSegments,
  segments,
} from '@/lib/server/db'
import type { PrincipalId, SegmentId } from '@quackback/ids'
import type { SQLWrapper } from 'drizzle-orm'
import { NotFoundError, InternalError } from '@/lib/shared/errors'
import { realEmail } from '@/lib/shared/anonymous-email'
import { NUMERIC_ATTR_OPS, isFiniteAttrNumber } from '@/lib/shared/custom-attr-filters'
import { likeText } from '@/lib/server/utils/like-pattern'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'users' })
import type {
  PortalUserListParams,
  PortalUserListResult,
  PortalUserListItem,
  UserSegmentSummary,
} from './user.types'

/**
 * Fetch segment summaries for a set of principal IDs in a single batch query.
 */
async function fetchSegmentsForPrincipals(
  principalIds: string[]
): Promise<Map<string, UserSegmentSummary[]>> {
  if (principalIds.length === 0) return new Map()

  const rows = await db
    .select({
      principalId: userSegments.principalId,
      segmentId: segments.id,
      segmentName: segments.name,
      segmentColor: segments.color,
      segmentType: segments.type,
    })
    .from(userSegments)
    .innerJoin(segments, eq(userSegments.segmentId, segments.id))
    .where(
      and(
        inArray(userSegments.principalId, principalIds as PrincipalId[]),
        isNull(segments.deletedAt)
      )
    )
    .orderBy(asc(segments.name))

  const map = new Map<string, UserSegmentSummary[]>()
  for (const row of rows) {
    if (!map.has(row.principalId)) map.set(row.principalId, [])
    map.get(row.principalId)!.push({
      id: row.segmentId as SegmentId,
      name: row.segmentName,
      color: row.segmentColor,
      type: row.segmentType as 'manual' | 'dynamic',
    })
  }
  return map
}

/**
 * Build a SQL comparison for activity count filters.
 */
function buildCountCondition(countExpr: ReturnType<typeof sql>, op: string, value: number) {
  switch (op) {
    case 'gt':
      return sql`${countExpr} > ${value}`
    case 'gte':
      return sql`${countExpr} >= ${value}`
    case 'lt':
      return sql`${countExpr} < ${value}`
    case 'lte':
      return sql`${countExpr} <= ${value}`
    case 'eq':
      return sql`${countExpr} = ${value}`
    default:
      return sql`${countExpr} >= ${value}`
  }
}

/**
 * A metadata value that reads as a plain decimal number: an optional sign,
 * then up to 255 digits with an optional decimal point and up to 255 more
 * (255 is the largest bound a Postgres regex allows). Every text this matches
 * is valid `numeric` input. It leaves out exponent notation, so no stored text
 * can ask the cast for an out-of-range value such as `1e999999`.
 */
const NUMERIC_TEXT = '^[-+]?([0-9]{1,255}([.][0-9]{0,255})?|[.][0-9]{1,255})$'

/**
 * A metadata text value as `numeric`, or NULL when it is not a plain decimal
 * number. An unchecked `::numeric` cast raised an error for any stored text
 * such as "gold", and a single such user failed the whole users list (DEF-45).
 * CASE evaluates the cast only for a row whose text passed the check, and a
 * NULL satisfies no comparison, so a user whose value is not a number is simply
 * not matched.
 */
function metadataNumber(text: ReturnType<typeof sql>) {
  return sql`(CASE WHEN ${text} ~ ${NUMERIC_TEXT} THEN (${text})::numeric END)`
}

/** Activity aggregates are global only when counts affect membership or order. */
function activityCounts(principalIds?: SQLWrapper) {
  const postCounts = db
    .select({
      principalId: posts.principalId,
      postCount: sql<number>`count(*)::int`.as('post_count'),
    })
    .from(posts)
    .where(and(isNull(posts.deletedAt), principalIds && inArray(posts.principalId, principalIds)))
    .groupBy(posts.principalId)
    .as('post_counts')

  const commentCounts = db
    .select({
      principalId: comments.principalId,
      commentCount: sql<number>`count(*)::int`.as('comment_count'),
    })
    .from(comments)
    .where(
      and(isNull(comments.deletedAt), principalIds && inArray(comments.principalId, principalIds))
    )
    .groupBy(comments.principalId)
    .as('comment_counts')

  const voteCounts = db
    .select({
      principalId: votes.principalId,
      voteCount: sql<number>`count(*)::int`.as('vote_count'),
    })
    .from(votes)
    .where(principalIds && inArray(votes.principalId, principalIds))
    .groupBy(votes.principalId)
    .as('vote_counts')

  return { postCounts, commentCounts, voteCounts }
}

/**
 * List portal users for an organization with activity counts
 *
 * Queries principal table for role='user'.
 * Display-only activity counts are restricted to the selected principal page.
 * Count-based ordering and filtering retain global aggregates before pagination.
 *
 * Supports optional filtering by segment IDs (OR logic — users in ANY selected segment).
 */
export async function listPortalUsers(
  params: PortalUserListParams = {}
): Promise<PortalUserListResult> {
  try {
    const {
      search,
      verified,
      dateFrom,
      dateTo,
      emailDomain,
      postCount: postCountFilter,
      voteCount: voteCountFilter,
      commentCount: commentCountFilter,
      customAttrs,
      sort = 'newest',
      page = 1,
      limit = 20,
      segmentIds,
      includeAnonymous = false,
    } = params

    const { postCounts, commentCounts, voteCounts } = activityCounts()
    const hasActivityFilters = Boolean(postCountFilter || voteCountFilter || commentCountFilter)
    const displayCountsOnly =
      !hasActivityFilters &&
      !['most_active', 'most_posts', 'most_comments', 'most_votes'].includes(sort)

    // Build conditions array - filter for role='user' (portal users only)
    const conditions = [eq(principal.role, 'user')]

    // Exclude anonymous users by default (principal.type='anonymous')
    if (!includeAnonymous) {
      conditions.push(eq(principal.type, 'user'))
    }

    if (search) {
      const pattern = `%${likeText(search)}%`
      conditions.push(or(ilike(user.name, pattern), ilike(user.email, pattern))!)
    }

    if (verified !== undefined) {
      conditions.push(eq(user.emailVerified, verified))
    }

    if (dateFrom) {
      conditions.push(sql`${principal.createdAt} >= ${dateFrom.toISOString()}`)
    }
    if (dateTo) {
      conditions.push(sql`${principal.createdAt} <= ${dateTo.toISOString()}`)
    }

    if (emailDomain) {
      conditions.push(ilike(user.email, `%@${likeText(emailDomain)}`))
    }

    if (postCountFilter) {
      const { op, value } = postCountFilter
      const countExpr = sql`COALESCE(${postCounts.postCount}, 0)`
      conditions.push(buildCountCondition(countExpr, op, value))
    }
    if (voteCountFilter) {
      const { op, value } = voteCountFilter
      const countExpr = sql`COALESCE(${voteCounts.voteCount}, 0)`
      conditions.push(buildCountCondition(countExpr, op, value))
    }
    if (commentCountFilter) {
      const { op, value } = commentCountFilter
      const countExpr = sql`COALESCE(${commentCounts.commentCount}, 0)`
      conditions.push(buildCountCondition(countExpr, op, value))
    }

    // Custom attribute filters (metadata JSON fields)
    if (customAttrs && customAttrs.length > 0) {
      for (const attr of customAttrs) {
        // A numeric comparison needs a finite number to compare with. The admin
        // list already drops one without (parseCustomAttrs); skip any other.
        if (NUMERIC_ATTR_OPS.has(attr.op) && !isFiniteAttrNumber(attr.value)) continue
        const jsonVal = sql`(${user.metadata}::jsonb->>${attr.key})`
        switch (attr.op) {
          case 'eq':
            conditions.push(sql`${jsonVal} = ${attr.value}`)
            break
          case 'neq':
            conditions.push(sql`${jsonVal} != ${attr.value}`)
            break
          case 'contains':
            conditions.push(sql`${jsonVal} ILIKE ${'%' + likeText(attr.value) + '%'}`)
            break
          case 'starts_with':
            conditions.push(sql`${jsonVal} ILIKE ${likeText(attr.value) + '%'}`)
            break
          case 'ends_with':
            conditions.push(sql`${jsonVal} ILIKE ${'%' + likeText(attr.value)}`)
            break
          case 'gt':
            conditions.push(sql`${metadataNumber(jsonVal)} > ${Number(attr.value)}`)
            break
          case 'gte':
            conditions.push(sql`${metadataNumber(jsonVal)} >= ${Number(attr.value)}`)
            break
          case 'lt':
            conditions.push(sql`${metadataNumber(jsonVal)} < ${Number(attr.value)}`)
            break
          case 'lte':
            conditions.push(sql`${metadataNumber(jsonVal)} <= ${Number(attr.value)}`)
            break
          case 'is_set':
            conditions.push(sql`${jsonVal} IS NOT NULL`)
            break
          case 'is_not_set':
            conditions.push(sql`${jsonVal} IS NULL`)
            break
        }
      }
    }

    // Segment filter — OR logic: users in ANY of the selected segments
    if (segmentIds && segmentIds.length > 0) {
      conditions.push(
        inArray(
          principal.id,
          db
            .select({ principalId: userSegments.principalId })
            .from(userSegments)
            .where(inArray(userSegments.segmentId, segmentIds as SegmentId[]))
        )
      )
    }

    const whereClause = and(...conditions)

    // Build sort order
    let orderBy
    switch (sort) {
      case 'oldest':
        orderBy = asc(principal.createdAt)
        break
      case 'most_active':
        orderBy = desc(
          sql`COALESCE(${postCounts.postCount}, 0) + COALESCE(${commentCounts.commentCount}, 0) + COALESCE(${voteCounts.voteCount}, 0)`
        )
        break
      case 'most_posts':
        orderBy = desc(sql`COALESCE(${postCounts.postCount}, 0)`)
        break
      case 'most_comments':
        orderBy = desc(sql`COALESCE(${commentCounts.commentCount}, 0)`)
        break
      case 'most_votes':
        orderBy = desc(sql`COALESCE(${voteCounts.voteCount}, 0)`)
        break
      case 'name':
        orderBy = asc(user.name)
        break
      case 'newest':
      default:
        orderBy = desc(principal.createdAt)
    }

    const pageBeforeActivity = () => {
      // Reusing this CTE in the three aggregates keeps their inputs bounded to
      // the selected page without adding another database round trip/snapshot.
      const userPage = db.$with('user_page').as(
        db
          .select({
            // Both source tables call their key "id"; explicit aliases avoid
            // ambiguous CTE columns while preserving the branded principal ID.
            principalId: sql<PrincipalId>`${principal.id}`
              .mapWith(principal.id)
              .as('page_principal_id'),
            userId: sql<string>`${user.id}`.mapWith(user.id).as('page_user_id'),
            name: user.name,
            email: user.email,
            image: user.image,
            emailVerified: user.emailVerified,
            metadata: user.metadata,
            joinedAt: principal.createdAt,
          })
          .from(principal)
          .innerJoin(user, eq(principal.userId, user.id))
          .where(whereClause)
          // Equal names/dates previously had unspecified ordering. Keep page
          // membership and the final joined result stable with the same key.
          .orderBy(orderBy, asc(principal.id))
          .limit(limit)
          .offset((page - 1) * limit)
      )
      const pageIds = db.select({ principalId: userPage.principalId }).from(userPage)
      const counts = activityCounts(pageIds)
      const pageOrder =
        sort === 'name'
          ? asc(userPage.name)
          : sort === 'oldest'
            ? asc(userPage.joinedAt)
            : desc(userPage.joinedAt)

      return db
        .with(userPage)
        .select({
          principalId: userPage.principalId,
          userId: userPage.userId,
          name: userPage.name,
          email: userPage.email,
          image: userPage.image,
          emailVerified: userPage.emailVerified,
          metadata: userPage.metadata,
          joinedAt: userPage.joinedAt,
          postCount: sql<number>`COALESCE(${counts.postCounts.postCount}, 0)`,
          commentCount: sql<number>`COALESCE(${counts.commentCounts.commentCount}, 0)`,
          voteCount: sql<number>`COALESCE(${counts.voteCounts.voteCount}, 0)`,
        })
        .from(userPage)
        .leftJoin(counts.postCounts, eq(counts.postCounts.principalId, userPage.principalId))
        .leftJoin(counts.commentCounts, eq(counts.commentCounts.principalId, userPage.principalId))
        .leftJoin(counts.voteCounts, eq(counts.voteCounts.principalId, userPage.principalId))
        .orderBy(pageOrder, asc(userPage.principalId))
    }

    // Count-based ordering/filtering must aggregate before pagination. Display
    // counts can be calculated after selecting the page with the same predicates.
    const [usersResult, countResult] = await Promise.all([
      displayCountsOnly
        ? pageBeforeActivity()
        : db
            .select({
              principalId: principal.id,
              userId: user.id,
              name: user.name,
              email: user.email,
              image: user.image,
              emailVerified: user.emailVerified,
              metadata: user.metadata,
              joinedAt: principal.createdAt,
              postCount: sql<number>`COALESCE(${postCounts.postCount}, 0)`,
              commentCount: sql<number>`COALESCE(${commentCounts.commentCount}, 0)`,
              voteCount: sql<number>`COALESCE(${voteCounts.voteCount}, 0)`,
            })
            .from(principal)
            .innerJoin(user, eq(principal.userId, user.id))
            .leftJoin(postCounts, eq(postCounts.principalId, principal.id))
            .leftJoin(commentCounts, eq(commentCounts.principalId, principal.id))
            .leftJoin(voteCounts, eq(voteCounts.principalId, principal.id))
            .where(whereClause)
            .orderBy(orderBy)
            .limit(limit)
            .offset((page - 1) * limit),
      // Count query needs the same JOINs when activity count filters are used
      hasActivityFilters
        ? db
            .select({ count: sql<number>`count(*)::int` })
            .from(principal)
            .innerJoin(user, eq(principal.userId, user.id))
            .leftJoin(postCounts, eq(postCounts.principalId, principal.id))
            .leftJoin(commentCounts, eq(commentCounts.principalId, principal.id))
            .leftJoin(voteCounts, eq(voteCounts.principalId, principal.id))
            .where(whereClause)
        : db
            .select({ count: sql<number>`count(*)::int` })
            .from(principal)
            .innerJoin(user, eq(principal.userId, user.id))
            .where(whereClause),
    ])

    const total = Number(countResult[0]?.count ?? 0)

    // Batch-fetch segments for the returned users
    const segmentMap = await fetchSegmentsForPrincipals(usersResult.map((r) => r.principalId))

    const items: PortalUserListItem[] = usersResult.map((row) => ({
      principalId: row.principalId,
      userId: row.userId,
      name: row.name,
      // Anonymous rows (shown only with "Include Anonymous") must render no email.
      email: realEmail(row.email),
      image: row.image,
      emailVerified: row.emailVerified,
      metadata: row.metadata,
      joinedAt: row.joinedAt,
      postCount: Number(row.postCount),
      commentCount: Number(row.commentCount),
      voteCount: Number(row.voteCount),
      segments: segmentMap.get(row.principalId) ?? [],
    }))

    return {
      items,
      total,
      hasMore: page * limit < total,
    }
  } catch (error) {
    log.error({ err: error }, 'failed to list portal users')
    throw new InternalError('DATABASE_ERROR', 'Failed to list portal users', error)
  }
}

/**
 * Remove a portal user from the portal (soft removal).
 *
 * Deletes the `principal` record (role='user') only — the Better-Auth `user`
 * and `account` rows are intentionally retained so we still recognize the
 * person if they return (and their re-join shows distinct "joined" vs
 * "account created" dates). The FK is `principal.userId -> user` with
 * onDelete cascade, so deleting the principal does NOT remove the user; a
 * returning sign-in re-provisions a principal via the SSO hooks or lazily.
 */
export async function removePortalUser(principalId: PrincipalId): Promise<void> {
  try {
    // Verify principal exists and has role='user'
    const existingPrincipal = await db.query.principal.findFirst({
      where: and(eq(principal.id, principalId), eq(principal.role, 'user')),
    })

    if (!existingPrincipal) {
      throw new NotFoundError(
        'MEMBER_NOT_FOUND',
        `Portal user with principal ID ${principalId} not found`
      )
    }

    // Delete principal record (user record will be deleted via CASCADE since user is org-scoped)
    await db.delete(principal).where(eq(principal.id, principalId))
  } catch (error) {
    if (error instanceof NotFoundError) throw error
    log.error({ err: error }, 'failed to remove portal user')
    throw new InternalError('DATABASE_ERROR', 'Failed to remove portal user', error)
  }
}
