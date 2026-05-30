/**
 * Client-safe live chat types, shared by the widget view, the admin inbox, and
 * the SSE transport. No server-only imports here — this module is bundled into
 * the browser.
 */
import type { ConversationId, ChatMessageId, PrincipalId } from '@quackback/ids'

export type ConversationStatus = 'open' | 'snoozed' | 'closed'
export type ChatSenderType = 'visitor' | 'agent'

/** Author identity attached to a rendered message. */
export interface ChatAuthorDTO {
  principalId: PrincipalId
  displayName: string | null
  avatarUrl: string | null
}

/** A single rendered chat message. `createdAt` is an ISO-8601 string. */
export interface ChatMessageDTO {
  id: ChatMessageId
  conversationId: ConversationId
  senderType: ChatSenderType
  content: string
  createdAt: string
  author: ChatAuthorDTO
}

/** A conversation row as surfaced to clients (inbox list + thread header). */
export interface ConversationDTO {
  id: ConversationId
  status: ConversationStatus
  subject: string | null
  lastMessagePreview: string | null
  lastMessageAt: string
  createdAt: string
  visitor: ChatAuthorDTO
  assignedAgent: ChatAuthorDTO | null
  /** Unread count for the side that requested it (0 when fully read). */
  unreadCount: number
}

/**
 * Events streamed over SSE. Every event names its conversation so a single
 * inbox stream can route across many threads. `message` events carry an
 * `id:` line equal to the message id for Last-Event-ID backfill.
 */
export type ChatStreamEvent =
  | { kind: 'message'; conversationId: ConversationId; message: ChatMessageDTO }
  | { kind: 'conversation'; conversation: ConversationDTO }
  | {
      kind: 'read'
      conversationId: ConversationId
      side: ChatSenderType
      at: string
    }

/** Hard caps shared by client + server validation. */
export const MAX_CHAT_MESSAGE_LENGTH = 4000
