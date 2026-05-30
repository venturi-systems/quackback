/**
 * Live chat domain service. Postgres is the source of truth; after each write
 * commits we publish a real-time event over Redis pub/sub (offline in-app /
 * email notifications are dispatched separately by the events pipeline).
 *
 * Two send paths, deliberately separate so sender side is decided server-side
 * and never trusted from the client:
 *   - sendVisitorMessage: the conversation owner posts (senderType 'visitor').
 *   - sendAgentMessage:    a team member replies (senderType 'agent').
 */
import { db, eq, conversations, chatMessages, type Conversation } from '@/lib/server/db'
import type { ConversationId, PrincipalId } from '@quackback/ids'
import { NotFoundError, ValidationError, ForbiddenError } from '@/lib/shared/errors'
import {
  canSendVisitorMessage,
  canStartConversation,
  canActAsAgent,
  canViewConversation,
} from '@/lib/server/policy/chat'
import type { Actor } from '@/lib/server/policy/types'
import { MAX_CHAT_MESSAGE_LENGTH, type ChatSenderType } from '@/lib/shared/chat/types'
import { publishChatEvent } from '@/lib/server/realtime/chat-channels'
import { truncate } from '@/lib/shared/utils/string'
import { notifyVisitorMessage, notifyAgentReply } from './chat.notify'
import { conversationToDTO, toMessageDTO, authorFromInput } from './chat.query'
import type {
  ChatAuthorInput,
  SendVisitorMessageInput,
  SendVisitorMessageResult,
  SendAgentMessageResult,
} from './chat.types'

const PREVIEW_LENGTH = 120

function validateContent(raw: string): string {
  const content = raw?.trim()
  if (!content) throw new ValidationError('VALIDATION_ERROR', 'Message cannot be empty')
  if (content.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      `Message must be ${MAX_CHAT_MESSAGE_LENGTH.toLocaleString()} characters or less`
    )
  }
  return content
}

function preview(content: string): string {
  return truncate(content, PREVIEW_LENGTH)
}

async function loadConversationOr404(conversationId: ConversationId): Promise<Conversation> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)
  if (!row) {
    throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
  }
  return row
}

/**
 * Read chokepoint: resolve a conversation the actor is allowed to see, or throw
 * NotFound (never Forbidden) so a non-owner can't probe conversation ids.
 */
export async function assertConversationViewable(
  conversationId: ConversationId,
  actor: Actor
): Promise<Conversation> {
  const conversation = await loadConversationOr404(conversationId)
  const decision = canViewConversation(actor, conversation)
  if (!decision.allowed) {
    throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
  }
  return conversation
}

/** Visitor send. Starts a conversation when no conversationId is supplied. */
export async function sendVisitorMessage(
  input: SendVisitorMessageInput,
  author: ChatAuthorInput,
  actor: Actor
): Promise<SendVisitorMessageResult> {
  const content = validateContent(input.content)

  let created = false
  const txResult = await db.transaction(async (tx) => {
    let conversation: Conversation
    if (input.conversationId) {
      const [existing] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1)
      if (!existing) {
        throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
      }
      const decision = canSendVisitorMessage(actor, existing)
      if (!decision.allowed) {
        // Hide existence from non-owners; surface the real reason otherwise.
        if (!canViewConversation(actor, existing).allowed) {
          throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
        }
        throw new ForbiddenError('FORBIDDEN', decision.reason)
      }
      conversation = existing
    } else {
      const start = canStartConversation(actor)
      if (!start.allowed) throw new ForbiddenError('FORBIDDEN', start.reason)
      const [createdConv] = await tx
        .insert(conversations)
        .values({
          visitorPrincipalId: author.principalId,
          status: 'open',
          subject: preview(content),
        })
        .returning()
      conversation = createdConv
      created = true
    }

    const [message] = await tx
      .insert(chatMessages)
      .values({
        conversationId: conversation.id,
        principalId: author.principalId,
        senderType: 'visitor',
        content,
      })
      .returning()

    const [updated] = await tx
      .update(conversations)
      .set({
        lastMessageAt: message.createdAt,
        lastMessagePreview: preview(content),
        // Visitor is active, so their side is read; a reply reopens a closed thread.
        visitorLastReadAt: message.createdAt,
        status: conversation.status === 'closed' ? 'open' : conversation.status,
        updatedAt: message.createdAt,
      })
      .where(eq(conversations.id, conversation.id))
      .returning()

    return { conversation: updated, message }
  })

  const messageDTO = toMessageDTO(txResult.message, authorFromInput(author))
  const conversationDTO = await conversationToDTO(txResult.conversation, 'agent')

  if (created) {
    publishChatEvent(conversationDTO.id, { kind: 'conversation', conversation: conversationDTO })
  }
  publishChatEvent(messageDTO.conversationId, {
    kind: 'message',
    conversationId: messageDTO.conversationId,
    message: messageDTO,
  })

  void notifyVisitorMessage({
    conversation: txResult.conversation,
    content,
    authorName: author.displayName ?? 'A visitor',
    isFirstMessage: created,
  })

  return { conversation: conversationDTO, message: messageDTO, created }
}

/** Agent reply. Auto-assigns the conversation to the replying agent if unowned. */
export async function sendAgentMessage(
  conversationId: ConversationId,
  rawContent: string,
  agent: ChatAuthorInput,
  actor: Actor
): Promise<SendAgentMessageResult> {
  const decision = canActAsAgent(actor)
  if (!decision.allowed) throw new ForbiddenError('FORBIDDEN', decision.reason)

  const content = validateContent(rawContent)

  const txResult = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1)
    if (!existing) {
      throw new NotFoundError('CONVERSATION_NOT_FOUND', 'Conversation not found')
    }

    const [message] = await tx
      .insert(chatMessages)
      .values({
        conversationId,
        principalId: agent.principalId,
        senderType: 'agent',
        content,
      })
      .returning()

    const [updated] = await tx
      .update(conversations)
      .set({
        lastMessageAt: message.createdAt,
        lastMessagePreview: preview(content),
        // Replying counts as reading; claim the conversation if unassigned.
        agentLastReadAt: message.createdAt,
        assignedAgentPrincipalId: existing.assignedAgentPrincipalId ?? agent.principalId,
        status: existing.status === 'closed' ? 'open' : existing.status,
        updatedAt: message.createdAt,
      })
      .where(eq(conversations.id, conversationId))
      .returning()

    return { message, conversation: updated }
  })

  const messageDTO = toMessageDTO(txResult.message, authorFromInput(agent))
  const conversationDTO = await conversationToDTO(txResult.conversation, 'visitor')

  publishChatEvent(conversationDTO.id, { kind: 'conversation', conversation: conversationDTO })
  publishChatEvent(messageDTO.conversationId, {
    kind: 'message',
    conversationId: messageDTO.conversationId,
    message: messageDTO,
  })

  void notifyAgentReply({
    visitorPrincipalId: txResult.conversation.visitorPrincipalId,
    content,
    agentName: agent.displayName ?? 'Support',
  })

  return { conversation: conversationDTO, message: messageDTO }
}

/** Agent action: set a conversation's status (open / snoozed / closed). */
export async function setConversationStatus(
  conversationId: ConversationId,
  status: 'open' | 'snoozed' | 'closed',
  actor: Actor
): Promise<Conversation> {
  const decision = canActAsAgent(actor)
  if (!decision.allowed) throw new ForbiddenError('FORBIDDEN', decision.reason)
  await loadConversationOr404(conversationId)
  const [updated] = await db
    .update(conversations)
    .set({ status, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning()
  const dto = await conversationToDTO(updated, 'agent')
  publishChatEvent(conversationId, { kind: 'conversation', conversation: dto })
  return updated
}

/** Agent action: (re)assign a conversation, or pass null to unassign. */
export async function assignConversation(
  conversationId: ConversationId,
  agentPrincipalId: PrincipalId | null,
  actor: Actor
): Promise<Conversation> {
  const decision = canActAsAgent(actor)
  if (!decision.allowed) throw new ForbiddenError('FORBIDDEN', decision.reason)
  await loadConversationOr404(conversationId)
  const [updated] = await db
    .update(conversations)
    .set({ assignedAgentPrincipalId: agentPrincipalId, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .returning()
  const dto = await conversationToDTO(updated, 'agent')
  publishChatEvent(conversationId, { kind: 'conversation', conversation: dto })
  return updated
}

/** Mark a conversation read up to now for one side. */
export async function markConversationRead(
  conversationId: ConversationId,
  side: ChatSenderType,
  actor: Actor
): Promise<void> {
  const conversation = await assertConversationViewable(conversationId, actor)
  const now = new Date()
  await db
    .update(conversations)
    .set(side === 'agent' ? { agentLastReadAt: now } : { visitorLastReadAt: now })
    .where(eq(conversations.id, conversation.id))
  publishChatEvent(conversationId, {
    kind: 'read',
    conversationId,
    side,
    at: now.toISOString(),
  })
}
