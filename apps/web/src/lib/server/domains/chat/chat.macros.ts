/**
 * Apply an agent macro: a one-click bundle of conversation actions. Each action
 * runs through the normal chat service (so policy gating, lifecycle, realtime
 * and notifications all behave identically to doing them by hand) in a fixed
 * order — reply → priority → assign → status — so a "reply and close" macro
 * sends before it closes.
 */
import type { ConversationId } from '@quackback/ids'
import type { Actor } from '@/lib/server/policy/types'
import type { ChatAuthorInput } from './chat.types'
import type { ChatMacro } from '@/lib/server/domains/settings/settings.types'
import {
  sendAgentMessage,
  setConversationPriority,
  assignConversation,
  setConversationStatus,
} from './chat.service'

export type MacroAction = 'reply' | 'priority' | 'assign' | 'status'

export async function applyMacro(
  conversationId: ConversationId,
  macro: ChatMacro,
  agent: ChatAuthorInput,
  actor: Actor
): Promise<{ applied: MacroAction[] }> {
  const applied: MacroAction[] = []

  const reply = macro.replyBody?.trim()
  if (reply) {
    await sendAgentMessage(conversationId, reply, agent, actor)
    applied.push('reply')
  }

  if (macro.setPriority) {
    await setConversationPriority(conversationId, macro.setPriority, actor)
    applied.push('priority')
  }

  if (macro.assignToSelf && actor.principalId) {
    await assignConversation(conversationId, actor.principalId, actor)
    applied.push('assign')
  }

  if (macro.setStatus) {
    await setConversationStatus(conversationId, macro.setStatus, actor)
    applied.push('status')
  }

  return { applied }
}
