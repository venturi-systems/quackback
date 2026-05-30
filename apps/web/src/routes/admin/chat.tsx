import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChatBubbleLeftRightIcon,
  PaperAirplaneIcon,
  CheckCircleIcon,
  ArrowUturnLeftIcon,
} from '@heroicons/react/24/outline'
import { toast } from 'sonner'
import type { ConversationId } from '@quackback/ids'
import {
  listConversationsFn,
  getConversationFn,
  sendAgentMessageFn,
  setConversationStatusFn,
  assignConversationFn,
  markChatReadFn,
} from '@/lib/server/functions/chat'
import type { ChatMessageDTO, ConversationDTO } from '@/lib/shared/chat/types'
import { useChatStream } from '@/lib/client/hooks/use-chat-stream'
import { Avatar } from '@/components/ui/avatar'
import { Spinner } from '@/components/shared/spinner'
import { EmptyState } from '@/components/shared/empty-state'
import { cn } from '@/lib/shared/utils'

export const Route = createFileRoute('/admin/chat')({
  loader: async () => {
    const { requireWorkspaceRole } = await import('@/lib/server/functions/workspace-utils')
    await requireWorkspaceRole({ data: { allowedRoles: ['admin', 'member'] } })
    return {}
  },
  component: ChatInboxPage,
})

type StatusFilter = 'open' | 'closed'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function ChatInboxPage() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<StatusFilter>('open')
  const [selectedId, setSelectedId] = useState<ConversationId | null>(null)

  const listKey = useMemo(() => ['admin', 'chat', 'conversations', status] as const, [status])

  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: listKey,
    queryFn: () => listConversationsFn({ data: { status } }),
    refetchInterval: 30_000, // polling fallback if the stream drops
  })

  const conversations = listData?.conversations ?? []

  // Live updates for the whole inbox over one cookie-authenticated stream.
  const refreshInbox = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'chat', 'conversations'] })
  }, [queryClient])

  useChatStream({
    enabled: true,
    buildUrl: async () => '/api/chat/stream?scope=inbox',
    onReconnect: refreshInbox,
    onEvent: (evt) => {
      // 'read' receipts don't change the agent-side inbox ordering or counts,
      // so only refetch the list on message/conversation events.
      if (evt.kind !== 'read') refreshInbox()
      if (evt.kind === 'message' && evt.conversationId === selectedId) {
        queryClient.setQueryData(
          ['admin', 'chat', 'thread', selectedId],
          (prev: { conversation: ConversationDTO; messages: ChatMessageDTO[] } | undefined) => {
            if (!prev) return prev
            if (prev.messages.some((m) => m.id === evt.message.id)) return prev
            return { ...prev, messages: [...prev.messages, evt.message] }
          }
        )
      }
    },
  })

  return (
    <div className="flex h-full">
      {/* Conversation list */}
      <div className="flex w-80 shrink-0 flex-col border-r border-border/50">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-border/50">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <ChatBubbleLeftRightIcon className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">Chat</h1>
            <p className="text-xs text-muted-foreground">Live conversations</p>
          </div>
        </div>
        <div className="flex gap-1 px-3 py-2 border-b border-border/40">
          {(['open', 'closed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={cn(
                'px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors',
                status === s ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No {status} conversations
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'flex w-full items-start gap-2.5 px-3 py-3 text-left border-b border-border/30 transition-colors',
                  selectedId === c.id ? 'bg-muted/60' : 'hover:bg-muted/30'
                )}
              >
                <Avatar
                  src={c.visitor.avatarUrl}
                  name={c.visitor.displayName ?? 'Visitor'}
                  className="size-8 text-xs shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {c.visitor.displayName ?? 'Visitor'}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {relativeTime(c.lastMessageAt)}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground mt-0.5">
                    {c.lastMessagePreview ?? c.subject ?? 'No messages yet'}
                  </p>
                </div>
                {c.unreadCount > 0 && (
                  <span className="shrink-0 mt-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                    {c.unreadCount}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Thread */}
      <div className="flex-1 min-w-0">
        {selectedId ? (
          <ChatThread key={selectedId} conversationId={selectedId} onChanged={refreshInbox} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={ChatBubbleLeftRightIcon}
              title="Select a conversation"
              description="Choose a conversation from the list to view and reply."
            />
          </div>
        )}
      </div>
    </div>
  )
}

function ChatThread({
  conversationId,
  onChanged,
}: {
  conversationId: ConversationId
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const threadKey = ['admin', 'chat', 'thread', conversationId] as const
  const [reply, setReply] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data, isLoading } = useQuery({
    queryKey: threadKey,
    queryFn: () => getConversationFn({ data: { conversationId } }),
  })

  const messages = data?.messages ?? []
  const conversation = data?.conversation

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, isLoading])

  // Clear the agent-side unread badge when a thread is open and new visitor
  // messages arrive — opening + reading should mark read, not only replying.
  useEffect(() => {
    if (isLoading || messages.length === 0) return
    if (messages.at(-1)?.senderType !== 'visitor') return
    void markChatReadFn({ data: { conversationId } })
      .then(() => onChanged())
      .catch(() => {})
  }, [conversationId, messages, isLoading, onChanged])

  const sendMutation = useMutation({
    mutationFn: (content: string) => sendAgentMessageFn({ data: { conversationId, content } }),
    onSuccess: (res) => {
      queryClient.setQueryData(
        threadKey,
        (prev: { conversation: ConversationDTO; messages: ChatMessageDTO[] } | undefined) =>
          prev && !prev.messages.some((m) => m.id === res.message.id)
            ? { ...prev, conversation: res.conversation, messages: [...prev.messages, res.message] }
            : prev
      )
      onChanged()
    },
    onError: () => toast.error('Failed to send message'),
  })

  const statusMutation = useMutation({
    mutationFn: (next: 'open' | 'closed') =>
      setConversationStatusFn({ data: { conversationId, status: next } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadKey })
      onChanged()
    },
    onError: () => toast.error('Failed to update conversation'),
  })

  const assignMutation = useMutation({
    mutationFn: () => assignConversationFn({ data: { conversationId, assignTo: 'me' } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: threadKey })
      onChanged()
    },
    onError: () => toast.error('Failed to assign conversation'),
  })

  const onSend = useCallback(() => {
    const text = reply.trim()
    if (!text || sendMutation.isPending) return
    setReply('')
    sendMutation.mutate(text)
  }, [reply, sendMutation])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  const isClosed = conversation?.status === 'closed'

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-5 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Avatar
            src={conversation?.visitor.avatarUrl ?? null}
            name={conversation?.visitor.displayName ?? 'Visitor'}
            className="size-8 text-xs shrink-0"
          />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {conversation?.visitor.displayName ?? 'Visitor'}
            </p>
            <p className="text-[11px] text-muted-foreground capitalize">{conversation?.status}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {!conversation?.assignedAgent && (
            <button
              type="button"
              onClick={() => assignMutation.mutate()}
              disabled={assignMutation.isPending}
              className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
            >
              Assign to me
            </button>
          )}
          <button
            type="button"
            onClick={() => statusMutation.mutate(isClosed ? 'open' : 'closed')}
            disabled={statusMutation.isPending}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted transition-colors"
          >
            {isClosed ? (
              <>
                <ArrowUturnLeftIcon className="h-3.5 w-3.5" /> Reopen
              </>
            ) : (
              <>
                <CheckCircleIcon className="h-3.5 w-3.5" /> Close
              </>
            )}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <AdminBubble key={m.id} message={m} />
          ))}
          {messages.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No messages yet</p>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border/50 p-3">
        <div className="flex items-end gap-2 rounded-lg border border-border bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-primary/20">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onSend()
              }
            }}
            rows={1}
            placeholder="Type your reply…"
            className="flex-1 resize-none bg-transparent text-sm outline-none max-h-32 py-1"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={!reply.trim() || sendMutation.isPending}
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40 transition-opacity"
            aria-label="Send reply"
          >
            <PaperAirplaneIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function AdminBubble({ message }: { message: ChatMessageDTO }) {
  // The agent is "me": agent messages right-aligned, visitor messages left.
  const isAgent = message.senderType === 'agent'
  return (
    <div className={cn('flex items-end gap-2', isAgent ? 'flex-row-reverse' : 'flex-row')}>
      {!isAgent && (
        <Avatar
          src={message.author.avatarUrl}
          name={message.author.displayName ?? 'Visitor'}
          className="size-6 text-[10px] shrink-0"
        />
      )}
      <div className={cn('flex max-w-[70%] flex-col', isAgent ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words',
            isAgent
              ? 'bg-primary text-primary-foreground rounded-br-md'
              : 'bg-muted text-foreground rounded-bl-md'
          )}
        >
          {message.content}
        </div>
        <span className="mt-0.5 px-1 text-[10px] text-muted-foreground/50">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
      </div>
    </div>
  )
}
