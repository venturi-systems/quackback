/**
 * Server functions for live chat.
 *
 * Visitor-facing functions (send / read own thread) accept either the portal
 * cookie or the widget Bearer token — the better-auth bearer plugin resolves
 * both transparently, so a single set of endpoints serves portal and widget.
 * Agent-facing functions are gated to team roles and re-checked independently
 * of the admin route guard.
 */
import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import type { ConversationId, PrincipalId } from '@quackback/ids'
import { MAX_CHAT_MESSAGE_LENGTH, type ChatSenderType } from '@/lib/shared/chat/types'
import {
  getOptionalAuth,
  requireAuth,
  policyActorFromAuth,
  hasAuthCredentials,
} from './auth-helpers'
import { isTeamMember } from '@/lib/shared/roles'

const sendMessageSchema = z.object({
  conversationId: z.string().optional(),
  content: z.string().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
})

const conversationIdSchema = z.object({ conversationId: z.string() })

const listMessagesSchema = z.object({
  conversationId: z.string(),
  before: z.string().optional(),
})

const listConversationsSchema = z.object({
  status: z.enum(['open', 'snoozed', 'closed']).optional(),
  assignedToMe: z.boolean().optional(),
  before: z.string().optional(),
})

const agentSendSchema = z.object({
  conversationId: z.string(),
  content: z.string().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
})

const setStatusSchema = z.object({
  conversationId: z.string(),
  status: z.enum(['open', 'snoozed', 'closed']),
})

const assignSchema = z.object({
  conversationId: z.string(),
  /** null / omitted = unassign; 'me' = assign to the current agent. */
  assignTo: z.union([z.literal('me'), z.null()]).optional(),
})

async function assertChatEnabled(): Promise<void> {
  const { isLiveChatEnabled } = await import('@/lib/server/domains/settings/settings.widget')
  if (!(await isLiveChatEnabled())) {
    throw new Error('Live chat is not enabled')
  }
}

// ── Visitor functions ────────────────────────────────────────────────────

/** Send a visitor message; creates the conversation on the first message. */
export const sendChatMessageFn = createServerFn({ method: 'POST' })
  .inputValidator(sendMessageSchema)
  .handler(async ({ data }) => {
    try {
      const { resolvePortalAccessForRequest } = await import('./portal-access')
      const access = await resolvePortalAccessForRequest()
      if (!access.granted) throw new Error('Portal access required')

      await assertChatEnabled()

      const ctx = await requireAuth({ roles: ['admin', 'member', 'user'] })
      const actor = await policyActorFromAuth(ctx)

      const { sendVisitorMessage } = await import('@/lib/server/domains/chat/chat.service')
      return await sendVisitorMessage(
        {
          conversationId: data.conversationId as ConversationId | undefined,
          content: data.content,
        },
        {
          principalId: ctx.principal.id,
          displayName: ctx.user.name,
          avatarUrl: ctx.user.image,
          email: ctx.user.email,
        },
        actor
      )
    } catch (error) {
      console.error('[fn:chat] sendChatMessageFn failed:', error)
      throw error
    }
  })

/** The current visitor's active conversation + first page of messages. */
export const getMyChatFn = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const { getLiveChatConfig, isLiveChatEnabled } =
      await import('@/lib/server/domains/settings/settings.widget')
    const [enabled, chatConfig] = await Promise.all([isLiveChatEnabled(), getLiveChatConfig()])
    const base = {
      enabled,
      welcomeMessage: chatConfig.welcomeMessage ?? null,
      offlineMessage: chatConfig.offlineMessage ?? null,
      teamName: chatConfig.teamName ?? null,
    }

    if (!enabled || !hasAuthCredentials()) {
      return { ...base, conversation: null, messages: [], agentsOnline: false }
    }

    const ctx = await getOptionalAuth()
    if (!ctx?.principal) {
      return { ...base, conversation: null, messages: [], agentsOnline: false }
    }

    const { getActiveConversationForVisitor, conversationToDTO, listMessages } =
      await import('@/lib/server/domains/chat/chat.query')
    const { isAnyAgentOnline } = await import('@/lib/server/realtime/presence')

    const [conversation, agentsOnline] = await Promise.all([
      getActiveConversationForVisitor(ctx.principal.id),
      isAnyAgentOnline(),
    ])
    if (!conversation) {
      return { ...base, conversation: null, messages: [], agentsOnline }
    }

    const [dto, page] = await Promise.all([
      conversationToDTO(conversation, 'visitor'),
      listMessages(conversation.id),
    ])
    return { ...base, conversation: dto, messages: page.messages, agentsOnline }
  } catch (error) {
    console.error('[fn:chat] getMyChatFn failed:', error)
    throw error
  }
})

/** Older messages for a conversation the caller can view (keyset pagination). */
export const listChatMessagesFn = createServerFn({ method: 'GET' })
  .inputValidator(listMessagesSchema)
  .handler(async ({ data }) => {
    try {
      const ctx = await requireAuth({ roles: ['admin', 'member', 'user'] })
      const actor = await policyActorFromAuth(ctx)
      const { assertConversationViewable } = await import('@/lib/server/domains/chat/chat.service')
      const { listMessages } = await import('@/lib/server/domains/chat/chat.query')
      await assertConversationViewable(data.conversationId as ConversationId, actor)
      return await listMessages(data.conversationId as ConversationId, { before: data.before })
    } catch (error) {
      console.error('[fn:chat] listChatMessagesFn failed:', error)
      throw error
    }
  })

/** Mark a conversation read up to now for the caller's side. */
export const markChatReadFn = createServerFn({ method: 'POST' })
  .inputValidator(conversationIdSchema)
  .handler(async ({ data }) => {
    try {
      const ctx = await requireAuth({ roles: ['admin', 'member', 'user'] })
      const actor = await policyActorFromAuth(ctx)
      const side: ChatSenderType = isTeamMember(ctx.principal.role) ? 'agent' : 'visitor'
      const { markConversationRead } = await import('@/lib/server/domains/chat/chat.service')
      await markConversationRead(data.conversationId as ConversationId, side, actor)
      return { ok: true }
    } catch (error) {
      console.error('[fn:chat] markChatReadFn failed:', error)
      throw error
    }
  })

/** Mint a short-lived token authorizing this principal's SSE stream. */
export const mintChatStreamTokenFn = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    await assertChatEnabled()
    const ctx = await requireAuth({ roles: ['admin', 'member', 'user'] })
    const { mintStreamToken } = await import('@/lib/server/realtime/stream-token')
    return { token: mintStreamToken(ctx.principal.id) }
  } catch (error) {
    console.error('[fn:chat] mintChatStreamTokenFn failed:', error)
    throw error
  }
})

// ── Agent functions ──────────────────────────────────────────────────────

/** Inbox feed for the support team. */
export const listConversationsFn = createServerFn({ method: 'GET' })
  .inputValidator(listConversationsSchema)
  .handler(async ({ data }) => {
    try {
      const ctx = await requireAuth({ roles: ['admin', 'member'] })
      const { listConversationsForAgent } = await import('@/lib/server/domains/chat/chat.query')
      return await listConversationsForAgent({
        status: data.status,
        assignedAgentPrincipalId: data.assignedToMe ? ctx.principal.id : undefined,
        before: data.before,
      })
    } catch (error) {
      console.error('[fn:chat] listConversationsFn failed:', error)
      throw error
    }
  })

/** A single conversation (agent view) + first page of messages. */
export const getConversationFn = createServerFn({ method: 'GET' })
  .inputValidator(listMessagesSchema)
  .handler(async ({ data }) => {
    try {
      const ctx = await requireAuth({ roles: ['admin', 'member'] })
      const actor = await policyActorFromAuth(ctx)
      const { assertConversationViewable } = await import('@/lib/server/domains/chat/chat.service')
      const { conversationToDTO, listMessages } =
        await import('@/lib/server/domains/chat/chat.query')
      const conversation = await assertConversationViewable(
        data.conversationId as ConversationId,
        actor
      )
      const [dto, page] = await Promise.all([
        conversationToDTO(conversation, 'agent'),
        listMessages(conversation.id, { before: data.before }),
      ])
      return { conversation: dto, messages: page.messages, hasMore: page.hasMore }
    } catch (error) {
      console.error('[fn:chat] getConversationFn failed:', error)
      throw error
    }
  })

/** Agent reply. */
export const sendAgentMessageFn = createServerFn({ method: 'POST' })
  .inputValidator(agentSendSchema)
  .handler(async ({ data }) => {
    try {
      const ctx = await requireAuth({ roles: ['admin', 'member'] })
      const actor = await policyActorFromAuth(ctx)
      const { sendAgentMessage } = await import('@/lib/server/domains/chat/chat.service')
      return await sendAgentMessage(
        data.conversationId as ConversationId,
        data.content,
        {
          principalId: ctx.principal.id,
          displayName: ctx.user.name,
          avatarUrl: ctx.user.image,
        },
        actor
      )
    } catch (error) {
      console.error('[fn:chat] sendAgentMessageFn failed:', error)
      throw error
    }
  })

export const setConversationStatusFn = createServerFn({ method: 'POST' })
  .inputValidator(setStatusSchema)
  .handler(async ({ data }) => {
    try {
      const ctx = await requireAuth({ roles: ['admin', 'member'] })
      const actor = await policyActorFromAuth(ctx)
      const { setConversationStatus } = await import('@/lib/server/domains/chat/chat.service')
      await setConversationStatus(data.conversationId as ConversationId, data.status, actor)
      return { ok: true }
    } catch (error) {
      console.error('[fn:chat] setConversationStatusFn failed:', error)
      throw error
    }
  })

export const assignConversationFn = createServerFn({ method: 'POST' })
  .inputValidator(assignSchema)
  .handler(async ({ data }) => {
    try {
      const ctx = await requireAuth({ roles: ['admin', 'member'] })
      const actor = await policyActorFromAuth(ctx)
      const { assignConversation } = await import('@/lib/server/domains/chat/chat.service')
      const assignTo: PrincipalId | null = data.assignTo === 'me' ? ctx.principal.id : null
      await assignConversation(data.conversationId as ConversationId, assignTo, actor)
      return { ok: true }
    } catch (error) {
      console.error('[fn:chat] assignConversationFn failed:', error)
      throw error
    }
  })
