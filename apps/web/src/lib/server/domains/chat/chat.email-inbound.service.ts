/**
 * Inbound email ingestion. A verified Resend `email.received` event is routed
 * into the conversation named by its plus-address (`reply+<id>@domain`) and the
 * visitor's stripped reply is appended through the normal visitor-message path,
 * so lifecycle (reopen), realtime publish and offline notification all behave
 * exactly as they do for a widget message — the polymorphic-conversation model.
 *
 * The webhook route is the trust boundary (signature-verified); this assumes a
 * verified payload and never throws on an unroutable one — it returns a status
 * the route maps to a 200 (so the provider stops retrying a message we can't
 * place) and logs the reason.
 */
import { db, eq, sql, chatMessages, conversations, principal } from '@/lib/server/db'
import type { ConversationId, PrincipalId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import { normalizePrincipalType } from '@/lib/server/functions/auth-helpers'
import { parseInboundEmail, extractReplyText } from './chat.email-inbound'
import { conversationIdFromInboundAddress } from './chat.email-channel'
import { assertChatSendRate, ChatRateLimitError } from './chat.ratelimit'
import { sendVisitorMessage } from './chat.service'

export type IngestInboundResult =
  | { status: 'ingested'; conversationId: ConversationId }
  | { status: 'duplicate' }
  | { status: 'no_conversation' }
  | { status: 'empty' }
  | { status: 'rate_limited' }

/** Find the conversation id carried by any recipient plus-address. */
function conversationIdFromRecipients(toAddresses: string[]): string | null {
  for (const addr of toAddresses) {
    const id = conversationIdFromInboundAddress(addr)
    if (id) return id
  }
  return null
}

export async function ingestInboundEmail(event: unknown): Promise<IngestInboundResult> {
  const data =
    (event && typeof event === 'object' ? (event as { data?: unknown }).data : null) ?? null
  const parsed = parseInboundEmail(data)

  const conversationId = conversationIdFromRecipients(parsed.toAddresses) as ConversationId | null
  if (!conversationId) return { status: 'no_conversation' }

  // Idempotency first: a redelivered Message-ID short-circuits before any other
  // read (the common retry case). The partial unique index on
  // (metadata->>'emailMessageId') is the hard backstop; this makes a retry a
  // graceful no-op instead of a unique-violation.
  if (parsed.messageId) {
    const [dupe] = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(sql`${chatMessages.metadata} ->> 'emailMessageId' = ${parsed.messageId}`)
      .limit(1)
    if (dupe) return { status: 'duplicate' }
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  })
  if (!conversation) return { status: 'no_conversation' }

  const content = extractReplyText(parsed.text ?? '')
  if (!content) return { status: 'empty' }

  const visitorPrincipalId = conversation.visitorPrincipalId as PrincipalId
  const visitor = await db.query.principal.findFirst({
    where: eq(principal.id, visitorPrincipalId),
  })
  if (!visitor) return { status: 'no_conversation' }

  // Same per-visitor throttle the widget send path enforces — the inbound email
  // channel must not be an unbounded back door for the offline-notification
  // fanout (a visitor mail-looping replies, or a client retrying with fresh
  // Message-IDs). Fails open on Redis errors. Ack (200) so the provider stops.
  try {
    await assertChatSendRate(visitorPrincipalId)
  } catch (err) {
    if (err instanceof ChatRateLimitError) return { status: 'rate_limited' }
    throw err
  }

  const actor: Actor = {
    principalId: visitorPrincipalId,
    role: (visitor.role ?? null) as Actor['role'],
    principalType: normalizePrincipalType(visitor.type),
    segmentIds: new Set(),
  }

  await sendVisitorMessage(
    {
      conversationId,
      content,
      metadata: { source: 'email', emailMessageId: parsed.messageId ?? undefined },
    },
    { principalId: visitorPrincipalId, displayName: visitor.displayName },
    actor
  )

  return { status: 'ingested', conversationId }
}
