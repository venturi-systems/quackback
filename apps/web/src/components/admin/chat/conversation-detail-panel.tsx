import { useQuery } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import {
  CalendarIcon,
  FaceSmileIcon,
  FlagIcon,
  InboxArrowDownIcon,
  TagIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline'
import type { ConversationId } from '@quackback/ids'
import type { Channel, ConversationDTO } from '@/lib/shared/chat/types'
import { listConversationsForUserFn } from '@/lib/server/functions/chat'
import { getPortalUserFn } from '@/lib/server/functions/admin'
import { useMediaQuery } from '@/lib/client/hooks/use-media-query'
import { PriorityControl } from './priority-control'
import { AssigneeControl } from './assignee-control'
import { ConversationTagsEditor } from './conversation-tags-editor'
import { StatusControl } from './status-control'
import { NoEmailBadge } from './channel-badge'
import { Avatar } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/shared/utils'

const CHANNEL_LABEL: Record<Channel, string> = {
  live_chat: 'Live chat',
  email: 'Email',
  web_form: 'Web form',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * A metadata row matching the feedback post-detail "Manage" card: an optional
 * leading outline icon + muted label on the left, the control/value on the
 * right. Rows with no icon (e.g. Status) sit flush to the card padding, exactly
 * like the reference sidebar's Status row.
 */
function Row({
  icon: Icon,
  label,
  align = 'center',
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>
  label: string
  align?: 'center' | 'start'
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'flex justify-between gap-3',
        align === 'start' ? 'items-start' : 'items-center'
      )}
    >
      {Icon ? (
        <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </div>
      ) : (
        <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
      )}
      <div className="flex min-w-0 max-w-[62%] justify-end">{children}</div>
    </div>
  )
}

/**
 * The conversation detail / "Manage" panel — the inbox's right column. Mirrors
 * the feedback post-detail metadata-sidebar: a floating bordered card with a
 * "Manage" header, a separator, and icon+label/value rows, then the contact
 * summary and the visitor's other conversations as border-separated sections.
 */
export function ConversationDetailPanel({
  conversation,
  onChanged,
  onSelectConversation,
}: {
  conversation: ConversationDTO
  onChanged: () => void
  onSelectConversation: (id: ConversationId) => void
}) {
  const visitorPrincipalId = conversation.visitor.principalId
  const name = conversation.visitor.displayName ?? 'Visitor'
  // The panel is `hidden xl:flex`; only fetch its data when it's actually shown
  // so smaller viewports don't pay for an invisible sidebar.
  const isVisible = useMediaQuery('(min-width: 1280px)')

  const { data: detail } = useQuery({
    queryKey: ['admin', 'inbox', 'visitor', visitorPrincipalId],
    queryFn: () => getPortalUserFn({ data: { principalId: visitorPrincipalId } }),
    enabled: isVisible && !!visitorPrincipalId,
    staleTime: 60_000,
  })
  const { data: history } = useQuery({
    queryKey: ['admin', 'inbox', 'user-conversations', visitorPrincipalId],
    queryFn: () => listConversationsForUserFn({ data: { principalId: visitorPrincipalId } }),
    enabled: isVisible && !!visitorPrincipalId,
    staleTime: 30_000,
  })

  const email = detail?.email ?? conversation.visitorEmail
  const previous = (history?.conversations ?? []).filter((c) => c.id !== conversation.id)

  return (
    <aside className="hidden w-72 shrink-0 flex-col xl:flex">
      <ScrollArea className="min-h-0 flex-1">
        <div className="m-3 space-y-5 rounded-xl border border-border/20 bg-card p-4 shadow-sm">
          {/* Manage */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Manage</span>
            </div>
            <div className="border-t border-border/30" />
            <Row label="Status">
              <StatusControl
                conversationId={conversation.id}
                status={conversation.status}
                onChanged={onChanged}
              />
            </Row>
            <Row icon={FlagIcon} label="Priority">
              <PriorityControl
                conversationId={conversation.id}
                value={conversation.priority}
                onChanged={onChanged}
              />
            </Row>
            <Row icon={UserCircleIcon} label="Assignee">
              <AssigneeControl
                conversationId={conversation.id}
                assignedAgent={conversation.assignedAgent}
                onChanged={onChanged}
              />
            </Row>
            <Row icon={TagIcon} label="Tags" align="start">
              <div className="flex flex-wrap justify-end gap-1">
                <ConversationTagsEditor conversationId={conversation.id} tags={conversation.tags} />
              </div>
            </Row>
            <Row icon={InboxArrowDownIcon} label="Channel">
              <span className="text-sm font-medium text-foreground">
                {CHANNEL_LABEL[conversation.channel]}
              </span>
            </Row>
            <Row icon={CalendarIcon} label="Created">
              <span className="text-sm font-medium text-foreground">
                {formatDate(conversation.createdAt)}
              </span>
            </Row>
            {conversation.csatRating != null && (
              <Row icon={FaceSmileIcon} label="CSAT">
                <span className="text-sm text-amber-500">
                  {'★'.repeat(conversation.csatRating)}
                  <span className="text-muted-foreground/40">
                    {'★'.repeat(Math.max(0, 5 - conversation.csatRating))}
                  </span>
                </span>
              </Row>
            )}
          </div>

          {/* Contact */}
          <div className="space-y-3 border-t border-border/30 pt-4">
            <div className="flex items-center gap-2.5">
              <Avatar
                src={conversation.visitor.avatarUrl}
                name={name}
                className="size-9 shrink-0 text-sm"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{name}</p>
                {email ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {email}
                    {!detail?.email && conversation.visitorEmail && (
                      <span className="ml-1 text-muted-foreground/50">(in chat)</span>
                    )}
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Anonymous <NoEmailBadge />
                  </p>
                )}
              </div>
            </div>
            {detail && (
              <div className="grid grid-cols-3 gap-1 text-center">
                {[
                  { label: 'Posts', value: detail.postCount },
                  { label: 'Comments', value: detail.commentCount },
                  { label: 'Votes', value: detail.voteCount },
                ].map((s) => (
                  <div key={s.label} className="rounded-md bg-muted/40 py-1.5">
                    <p className="text-sm font-semibold">{s.value}</p>
                    <p className="text-[10px] text-muted-foreground">{s.label}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Previous conversations */}
          {previous.length > 0 && (
            <div className="space-y-1.5 border-t border-border/30 pt-4">
              <p className="text-xs font-medium text-muted-foreground">Previous conversations</p>
              {previous.slice(0, 8).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onSelectConversation(c.id)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                >
                  <span className="w-full truncate text-xs text-foreground/90">
                    {c.subject ?? c.lastMessagePreview ?? 'Conversation'}
                  </span>
                  <span className="text-[10px] capitalize text-muted-foreground">
                    {c.status} ·{' '}
                    {formatDistanceToNow(new Date(c.lastMessageAt), { addSuffix: true })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </aside>
  )
}
