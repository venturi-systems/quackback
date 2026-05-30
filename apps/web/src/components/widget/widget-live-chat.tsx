import { useCallback, useEffect, useRef, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { PaperAirplaneIcon } from '@heroicons/react/24/solid'
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import type { ConversationId } from '@quackback/ids'
import { Avatar } from '@/components/ui/avatar'
import { cn } from '@/lib/shared/utils'
import { useWidgetAuth } from './widget-auth-provider'
import { getWidgetAuthHeaders } from '@/lib/client/widget-auth'
import { useChatStream } from '@/lib/client/hooks/use-chat-stream'
import type { ChatMessageDTO } from '@/lib/shared/chat/types'
import {
  getMyChatFn,
  sendChatMessageFn,
  listChatMessagesFn,
  markChatReadFn,
  mintChatStreamTokenFn,
} from '@/lib/server/functions/chat'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function WidgetLiveChat() {
  const intl = useIntl()
  const { ensureSession, sessionVersion } = useWidgetAuth()

  const [loading, setLoading] = useState(true)
  const [conversationId, setConversationId] = useState<ConversationId | null>(null)
  const [messages, setMessages] = useState<ChatMessageDTO[]>([])
  const [welcomeMessage, setWelcomeMessage] = useState<string | null>(null)
  const [offlineMessage, setOfflineMessage] = useState<string | null>(null)
  const [teamName, setTeamName] = useState<string | null>(null)
  const [agentsOnline, setAgentsOnline] = useState(false)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const scrollViewportRef = useRef<HTMLDivElement>(null)

  const appendMessage = useCallback((msg: ChatMessageDTO) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]))
  }, [])

  // Initial load — resumes an existing conversation for the current principal
  // (works without forcing a session: getMyChat returns just the greeting when
  // there's no session yet). Re-keyed on sessionVersion so it reloads after
  // identify swaps the actor.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await getMyChatFn({ headers: getWidgetAuthHeaders() })
        if (cancelled) return
        setWelcomeMessage(res.welcomeMessage)
        setOfflineMessage(res.offlineMessage)
        setTeamName(res.teamName)
        setAgentsOnline(res.agentsOnline)
        setConversationId((res.conversation?.id as ConversationId | undefined) ?? null)
        setMessages(res.messages)
      } catch {
        /* leave greeting-only state */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionVersion])

  // Refetch the authoritative thread after a reconnect to catch anything missed.
  const refreshMessages = useCallback(async () => {
    if (!conversationId) return
    try {
      const page = await listChatMessagesFn({
        data: { conversationId },
        headers: getWidgetAuthHeaders(),
      })
      setMessages(page.messages)
    } catch {
      /* keep current messages */
    }
  }, [conversationId])

  useChatStream({
    enabled: conversationId != null,
    resetKey: conversationId ?? '',
    buildUrl: async () => {
      if (!conversationId) return null
      try {
        const { token } = await mintChatStreamTokenFn({ headers: getWidgetAuthHeaders() })
        if (!token) return null
        return `/api/chat/stream?conversationId=${encodeURIComponent(
          conversationId
        )}&token=${encodeURIComponent(token)}`
      } catch {
        return null
      }
    },
    onEvent: (evt) => {
      if (evt.kind === 'message') appendMessage(evt.message)
    },
    onReconnect: () => void refreshMessages(),
  })

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = scrollViewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, loading])

  // Clear unread on the visitor side only when the newest message is from an
  // agent — skip the visitor's own outbound sends (avoids a write + 'read'
  // broadcast on every send).
  useEffect(() => {
    if (!conversationId) return
    if (messages.at(-1)?.senderType !== 'agent') return
    void markChatReadFn({ data: { conversationId }, headers: getWidgetAuthHeaders() }).catch(
      () => {}
    )
  }, [conversationId, messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    setInput('')

    const ready = await ensureSession()
    if (!ready) {
      setInput(text)
      setSending(false)
      return
    }
    try {
      const res = await sendChatMessageFn({
        data: { conversationId: conversationId ?? undefined, content: text },
        headers: getWidgetAuthHeaders(),
      })
      setConversationId(res.conversation.id as ConversationId)
      appendMessage(res.message)
    } catch {
      setInput(text)
    } finally {
      setSending(false)
    }
  }, [input, sending, conversationId, ensureSession, appendMessage])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void send()
      }
    },
    [send]
  )

  return (
    <div className="flex flex-col h-full">
      {/* Presence strip */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 shrink-0">
        <span
          className={cn(
            'size-2 rounded-full',
            agentsOnline ? 'bg-emerald-500' : 'bg-muted-foreground/40'
          )}
          aria-hidden
        />
        <span className="text-xs text-muted-foreground">
          {agentsOnline ? (
            <FormattedMessage id="widget.chat.online" defaultMessage="We're online" />
          ) : (
            <FormattedMessage id="widget.chat.offline" defaultMessage="We'll reply by email" />
          )}
        </span>
      </div>

      <div ref={scrollViewportRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-3 px-3 py-4">
          {/* Greeting — rendered from settings, not stored as a message. */}
          {welcomeMessage && (
            <ChatBubble side="agent" authorName={teamName ?? undefined} content={welcomeMessage} />
          )}

          {messages.map((m) => (
            <ChatBubble
              key={m.id}
              side={m.senderType === 'visitor' ? 'visitor' : 'agent'}
              authorName={
                m.senderType === 'agent'
                  ? (m.author.displayName ?? teamName ?? undefined)
                  : undefined
              }
              authorAvatar={m.senderType === 'agent' ? m.author.avatarUrl : null}
              content={m.content}
              time={formatTime(m.createdAt)}
            />
          ))}

          {!loading && messages.length === 0 && !welcomeMessage && (
            <div className="flex flex-col items-center justify-center text-center py-8 px-4">
              <ChatBubbleLeftRightIcon className="w-8 h-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm font-medium text-muted-foreground/70">
                <FormattedMessage
                  id="widget.chat.startPrompt"
                  defaultMessage="Send us a message and we'll get back to you."
                />
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Offline hint */}
      {!agentsOnline && offlineMessage && (
        <p className="px-4 pt-2 text-[11px] text-muted-foreground/70 text-center">
          {offlineMessage}
        </p>
      )}

      {/* Composer */}
      <div className="border-t border-border/40 p-2 shrink-0">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-primary/20">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={intl.formatMessage({
              id: 'widget.chat.placeholder',
              defaultMessage: 'Type your message…',
            })}
            className="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none max-h-24 py-1"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!input.trim() || sending}
            className="shrink-0 flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
            aria-label={intl.formatMessage({ id: 'widget.chat.send', defaultMessage: 'Send' })}
          >
            <PaperAirplaneIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

interface ChatBubbleProps {
  side: 'visitor' | 'agent'
  content: string
  authorName?: string
  authorAvatar?: string | null
  time?: string
}

function ChatBubble({ side, content, authorName, authorAvatar, time }: ChatBubbleProps) {
  const isVisitor = side === 'visitor'
  return (
    <div className={cn('flex items-end gap-2', isVisitor ? 'flex-row-reverse' : 'flex-row')}>
      {!isVisitor && (
        <Avatar
          src={authorAvatar ?? null}
          name={authorName ?? 'Support'}
          className="size-6 text-[10px] shrink-0"
        />
      )}
      <div className={cn('flex flex-col max-w-[78%]', isVisitor ? 'items-end' : 'items-start')}>
        {!isVisitor && authorName && (
          <span className="text-[10px] text-muted-foreground/60 mb-0.5 px-1">{authorName}</span>
        )}
        <div
          className={cn(
            'rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words leading-relaxed',
            isVisitor
              ? 'bg-primary text-primary-foreground rounded-br-md'
              : 'bg-muted text-foreground rounded-bl-md'
          )}
        >
          {content}
        </div>
        {time && <span className="text-[10px] text-muted-foreground/50 mt-0.5 px-1">{time}</span>}
      </div>
    </div>
  )
}
