/**
 * Channel naming + publish helpers for live chat real-time delivery.
 *
 * Two channels per workspace process:
 *   - per-conversation: the visitor of that conversation subscribes here.
 *   - inbox: every agent subscribes here for cross-conversation updates.
 *
 * A new message is published to BOTH so the visitor's thread and every
 * agent's inbox update at once. Clients dedupe by message id.
 */
import type { ConversationId } from '@quackback/ids'
import type { ChatStreamEvent } from '@/lib/shared/chat/types'
import { publish } from './pubsub'

export function conversationChannel(conversationId: ConversationId): string {
  return `chat:conv:${conversationId}`
}

/** Single shared channel all agents listen on for inbox-wide updates. */
export const CHAT_INBOX_CHANNEL = 'chat:inbox'

/** Publish a stream event to the conversation channel + the agent inbox. */
export function publishChatEvent(conversationId: ConversationId, event: ChatStreamEvent): void {
  publish(conversationChannel(conversationId), event)
  publish(CHAT_INBOX_CHANNEL, event)
}
