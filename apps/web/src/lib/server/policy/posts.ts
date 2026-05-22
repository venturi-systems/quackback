/**
 * Post view + create authorization.
 *
 * Composes with policy.boards — a post is never visible if its board
 * isn't visible, and create is always denied when view is denied.
 */
import { and, eq, or, sql, type SQL } from 'drizzle-orm'
import {
  posts,
  type BoardAudience,
  type BoardModeration,
  type ModerationState,
} from '@/lib/server/db'
import type { PrincipalId } from '@quackback/ids'
import { allowDecision, denyDecision, isTeamActor, type Actor, type Decision } from './types'
import { canViewBoard, boardViewFilter } from './boards'

/** A board's approval policy after `'inherit'` has been resolved away. */
export type ResolvedRequireApproval = 'none' | 'anonymous' | 'authenticated' | 'all'

/**
 * Collapse a board's `requireApproval` to a concrete level. Total: an absent
 * board config inherits; `'inherit'` takes the workspace default; an absent
 * global default is `'none'`. The policy layer never sees `'inherit'`.
 */
export function resolveRequireApproval(
  boardModeration: BoardModeration | undefined,
  globalDefault: ResolvedRequireApproval | undefined
): ResolvedRequireApproval {
  const board = boardModeration?.requireApproval ?? 'inherit'
  if (board === 'inherit') return globalDefault ?? 'none'
  return board
}

interface PostShape {
  moderationState: ModerationState
  principalId?: PrincipalId | null
}

interface BoardShape {
  audience: BoardAudience
  moderation?: BoardModeration
}

const isTeam = isTeamActor

export function canViewPost(actor: Actor, post: PostShape, board: BoardShape): Decision {
  const boardDecision = canViewBoard(actor, board)
  if (!boardDecision.allowed) return boardDecision

  if (isTeam(actor)) {
    return post.moderationState === 'deleted' ? denyDecision('Post was removed') : allowDecision()
  }

  if (post.moderationState === 'published') return allowDecision()
  if (
    post.moderationState === 'pending' &&
    actor.principalId &&
    post.principalId === actor.principalId
  ) {
    return allowDecision()
  }
  return denyDecision('Post is not yet visible')
}

/**
 * SQL predicate for post list queries. Caller must join `boards` so
 * that boards.audience is resolvable. The predicate composes WITH
 * `isNull(posts.deletedAt)` from existing list queries — never replaces it.
 */
export function postViewFilter(actor: Actor): SQL {
  if (isTeam(actor)) {
    return sql`${posts.moderationState} <> 'deleted'`
  }
  const principalIdParam: string | null = actor.principalId ?? null
  const ownPending =
    principalIdParam !== null
      ? and(eq(posts.moderationState, 'pending'), eq(posts.principalId, principalIdParam as never))
      : sql`false`
  return and(boardViewFilter(actor), or(eq(posts.moderationState, 'published'), ownPending))!
}

export type CreateDecision =
  | { allowed: true; requiresApproval: boolean }
  | { allowed: false; reason: string }

export function canCreatePost(
  actor: Actor,
  board: BoardShape,
  globalDefault: ResolvedRequireApproval | undefined
): CreateDecision {
  const view = canViewBoard(actor, board)
  if (!view.allowed) return { allowed: false, reason: view.reason }

  const moderation = board.moderation ?? { requireApproval: 'inherit', trustedSegmentIds: [] }
  const requireApproval = resolveRequireApproval(moderation, globalDefault)

  if (moderation.trustedSegmentIds.some((id) => actor.segmentIds.has(id as never))) {
    return { allowed: true, requiresApproval: false }
  }
  if (isTeam(actor)) {
    return { allowed: true, requiresApproval: false }
  }

  const requires =
    requireApproval === 'all' ||
    (requireApproval === 'anonymous' && actor.principalType !== 'user') ||
    (requireApproval === 'authenticated' && actor.principalType === 'user')

  return { allowed: true, requiresApproval: requires }
}
