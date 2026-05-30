import type { ConversationId, PrincipalId } from '@quackback/ids'
import type { ChatMessageDTO, ConversationDTO } from '@/lib/shared/chat/types'

/** Author identity passed into a send call (resolved from the auth context). */
export interface ChatAuthorInput {
  principalId: PrincipalId
  displayName?: string | null
  avatarUrl?: string | null
  /** Email is used only by the offline-notification path, never rendered. */
  email?: string | null
}

/** Visitor send: omit conversationId to start a new conversation. */
export interface SendVisitorMessageInput {
  conversationId?: ConversationId
  content: string
}

export interface SendVisitorMessageResult {
  conversation: ConversationDTO
  message: ChatMessageDTO
  /** True when this send created the conversation (first message). */
  created: boolean
}

export interface SendAgentMessageResult {
  conversation: ConversationDTO
  message: ChatMessageDTO
}
