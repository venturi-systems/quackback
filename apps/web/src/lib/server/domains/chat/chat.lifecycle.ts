import type { ConversationStatus } from '@/lib/shared/chat/types'

/**
 * Conversation status transitions, kept pure so they're unit-tested directly.
 *
 * A "content surface" lifecycle: open (active) | pending (waiting on the
 * customer) | closed (resolved).
 */

/**
 * A visitor message always surfaces the conversation — it returns to 'open'
 * from any prior state: a reply answers a 'pending' thread and reopens a
 * 'closed' one. (No parameter: the result never depends on the prior status.)
 */
export function applyVisitorReopenStatus(): ConversationStatus {
  return 'open'
}

/**
 * An agent reply reopens a 'closed' thread, but preserves 'pending' (still
 * waiting on the customer — replying again doesn't change that).
 */
export function applyAgentReopenStatus(current: ConversationStatus): ConversationStatus {
  return current === 'closed' ? 'open' : current
}

/** resolvedAt is stamped when a conversation is closed/resolved, cleared otherwise. */
export function resolvedAtForStatus(status: ConversationStatus, now: Date): Date | null {
  return status === 'closed' ? now : null
}

/**
 * When an assigned agent goes offline, return their unanswered conversations to
 * the queue so they aren't stranded — but only open threads the agent never
 * replied to. An engaged thread (an agent reply exists) stays theirs; closed
 * and pending threads are left alone.
 */
export function shouldRequeueOnAgentOffline(
  status: ConversationStatus,
  hasAgentReply: boolean
): boolean {
  return status === 'open' && !hasAgentReply
}

/**
 * The new agent read-watermark for "mark unread from this message". The anchor
 * and everything after it must count as unread, so the watermark moves to just
 * before the anchor — but only ever BACKWARD. Marking an already-unread message
 * unread is a no-op, and we never advance the watermark (which would silently
 * re-mark earlier unread messages as read). A never-read conversation (null
 * watermark) is already fully unread, so it stays null.
 */
export function unreadWatermarkFromAnchor(
  currentAgentLastReadAt: Date | null,
  anchorCreatedAt: Date
): Date | null {
  if (currentAgentLastReadAt === null) return null
  const candidate = new Date(anchorCreatedAt.getTime() - 1)
  return candidate < currentAgentLastReadAt ? candidate : currentAgentLastReadAt
}
