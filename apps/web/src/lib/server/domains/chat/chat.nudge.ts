/**
 * Stale-draft nudge. When an agent proposes a draft feedback post, a delayed
 * job is scheduled (proposePost). A day later, if the card is still 'proposed'
 * and the visitor has a real email, we send a single gentle reminder. An agent
 * can also trigger the same reminder by hand from the inbox card.
 */
import { db, eq, conversations, chatMessages, principal, user } from '@/lib/server/db'
import type { ChatMessageId, ConversationId, PrincipalId } from '@quackback/ids'
import type { ChatCard } from '@/lib/shared/db-types'
import { buildHookContext } from '@/lib/server/events/hook-context'
import { realEmail } from '@/lib/shared/anonymous-email'
import { resolveReplyRecipient } from './chat.recipient'

/** A proposed draft sits a full day before we reach out about it. */
export const DRAFT_NUDGE_DELAY_MS = 24 * 60 * 60 * 1000

/**
 * Pure gate: a nudge is warranted only for a still-proposed draft-post card
 * with a deliverable recipient. Kept side-effect-free so the precedence is
 * unit-tested directly.
 */
export function shouldSendNudge(card: ChatCard | undefined, recipient: string | null): boolean {
  return card?.type === 'draft_post' && card.status === 'proposed' && !!recipient
}

/**
 * Resolve the deliverable recipient for a conversation's visitor, mirroring the
 * agent-reply precedence (account email > principal contact email > pre-chat
 * email) and dropping synthetic anonymous addresses.
 */
async function resolveVisitorRecipient(
  visitorPrincipalId: PrincipalId,
  visitorEmail: string | null
): Promise<string | null> {
  const [visitor] = await db
    .select({ type: principal.type, email: user.email, contactEmail: principal.contactEmail })
    .from(principal)
    .leftJoin(user, eq(principal.userId, user.id))
    .where(eq(principal.id, visitorPrincipalId))
    .limit(1)

  const recipient = resolveReplyRecipient(visitor, visitor?.contactEmail, visitorEmail)
  return realEmail(recipient)
}

/**
 * Shared send path for both the delayed job and the manual button. Re-fetches
 * the message so a card the visitor has since published/dismissed is a no-op,
 * and persists `nudgedAt` so the reminder fires at most once (unless forced).
 */
async function runNudge(
  messageId: ChatMessageId,
  conversationId: ConversationId,
  opts: { force?: boolean }
): Promise<void> {
  const [message] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1)
  if (!message) return

  const card = message.metadata?.card
  // Already reminded — don't repeat unless the agent explicitly forces it.
  if (message.metadata?.nudgedAt && !opts.force) return

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  if (!conversation || !conversation.visitorPrincipalId) return

  const recipient = await resolveVisitorRecipient(
    conversation.visitorPrincipalId,
    conversation.visitorEmail
  )

  if (!shouldSendNudge(card, recipient)) return

  const ctx = await buildHookContext()
  if (!ctx) return

  // Deep-link straight to the widget's chat view, same as the agent-reply email.
  // The URL only navigates — it carries no capability of its own.
  const ctaUrl = `${ctx.portalBaseUrl.replace(/\/$/, '')}/widget/?c=${encodeURIComponent(conversationId)}`

  const { sendDraftNudgeEmail } = await import('@quackback/email')
  await sendDraftNudgeEmail({
    to: recipient!,
    workspaceName: ctx.workspaceName,
    logoUrl: ctx.logoUrl ?? undefined,
    draftTitle: (card as Extract<ChatCard, { type: 'draft_post' }>).title,
    ctaUrl,
  })

  await db
    .update(chatMessages)
    .set({ metadata: { ...message.metadata, nudgedAt: new Date().toISOString() } })
    .where(eq(chatMessages.id, messageId))
}

/**
 * Delayed-job entry point. Scheduled on propose; runs a day later. Short-circuits
 * if the draft is no longer proposed, the visitor is unreachable, or a nudge
 * already went out.
 */
export async function handleDraftNudge(payload: {
  messageId: ChatMessageId
  conversationId: ConversationId
}): Promise<void> {
  await runNudge(payload.messageId, payload.conversationId, {})
}

/**
 * Manual entry point: an agent triggers the reminder from the inbox card.
 * Honors the once-only `nudgedAt` guard unless `force` is set.
 */
export async function nudgeDraftPost(
  messageId: ChatMessageId,
  opts?: { force?: boolean }
): Promise<void> {
  const [message] = await db
    .select({ conversationId: chatMessages.conversationId })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1)
  if (!message) return
  await runNudge(messageId, message.conversationId, { force: opts?.force })
}
