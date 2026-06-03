import type { ConversationId } from '@quackback/ids'
import type {
  ConversationDTO,
  ConversationPriority,
  ConversationStatus,
} from '@/lib/shared/chat/types'
import { priorityMeta } from '@/lib/shared/chat/priority-meta'
import { PriorityDot, PriorityMenuItems } from '@/components/admin/chat/priority-control'
import { ChannelBadge } from '@/components/admin/chat/channel-badge'
import { InboxScopeMenu, type InboxNavItem } from '@/components/admin/chat/inbox-nav-sidebar'
import { TagChip } from '@/components/shared/tag-chip'
import { Spinner } from '@/components/shared/spinner'
import { Avatar } from '@/components/ui/avatar'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/shared/utils'

type AssigneeFilter = 'all' | 'mine' | 'unassigned'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

interface ConversationListColumnProps {
  nav: InboxNavItem
  onSelectNav: (item: InboxNavItem) => void
  scopeLabel: string
  /** Whether to show the assignee/status/priority refinements (open-ended scopes only). */
  showRefinements: boolean
  searchInput: string
  onSearchInput: (value: string) => void
  assignee: AssigneeFilter
  onAssignee: (value: AssigneeFilter) => void
  status: ConversationStatus
  onStatus: (value: ConversationStatus) => void
  priorityFilter: ConversationPriority | 'all'
  onPriorityFilter: (value: ConversationPriority | 'all') => void
  loading: boolean
  conversations: ConversationDTO[]
  selectedId: ConversationId | null
  onSelect: (id: ConversationId) => void
}

/**
 * The middle column of the inbox: scope header (desktop label / mobile scope
 * menu), search, the assignee/status/priority refinements, and the conversation
 * list itself. Purely presentational — all state lives in the inbox route.
 */
export function ConversationListColumn({
  nav,
  onSelectNav,
  scopeLabel,
  showRefinements,
  searchInput,
  onSearchInput,
  assignee,
  onAssignee,
  status,
  onStatus,
  priorityFilter,
  onPriorityFilter,
  loading,
  conversations,
  selectedId,
  onSelect,
}: ConversationListColumnProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 w-full shrink-0 flex-col border-r border-border/50 md:w-80',
        // On mobile the list and thread are one column: hide the list while a
        // conversation is open (a back button returns to it).
        selectedId && 'hidden md:flex'
      )}
    >
      <div className="border-b border-border/50 px-4 py-[1.1rem]">
        {/* At lg+ the nav sidebar owns scope selection, so the header is a
            plain label. Below lg the sidebar is hidden, so offer a dropdown. */}
        <h2 className="hidden truncate text-sm font-semibold leading-tight lg:block">
          {scopeLabel}
        </h2>
        <div className="lg:hidden">
          <InboxScopeMenu nav={nav} onSelect={onSelectNav} />
        </div>
      </div>
      <div className="px-3 pt-2">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          placeholder="Search conversations…"
          className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>
      {showRefinements && (
        <>
          <div className="px-3 pt-2">
            <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
              {(['all', 'mine', 'unassigned'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => onAssignee(a)}
                  className={cn(
                    'rounded px-2.5 py-1 font-medium capitalize transition-colors',
                    assignee === a
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted'
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none px-3 py-2">
            {(['open', 'pending', 'closed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onStatus(s)}
                className={cn(
                  'shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                  status === s
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted'
                )}
              >
                {s}
              </button>
            ))}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Filter by priority"
                  className={cn(
                    'ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    priorityFilter !== 'all'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted'
                  )}
                >
                  <PriorityDot priority={priorityFilter === 'all' ? 'none' : priorityFilter} />
                  {priorityFilter === 'all' ? 'Priority' : priorityMeta(priorityFilter).label}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onPriorityFilter('all')} className="text-xs">
                  All priorities
                </DropdownMenuItem>
                <PriorityMenuItems
                  selected={priorityFilter === 'all' ? undefined : priorityFilter}
                  onSelect={onPriorityFilter}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : conversations.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {nav.kind === 'tag'
              ? `No conversations labelled ${scopeLabel}`
              : nav.view === 'mentions'
                ? 'No conversations mention you yet'
                : nav.view === 'unattended'
                  ? 'Nothing unattended — every open chat has an owner'
                  : assignee === 'mine'
                    ? `No ${status} conversations assigned to you`
                    : assignee === 'unassigned'
                      ? `No unassigned ${status} conversations`
                      : `No ${status} conversations`}
          </div>
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                'flex w-full items-start gap-2.5 border-b border-border/30 px-3 py-3 text-left transition-colors',
                selectedId === c.id ? 'bg-muted/60' : 'hover:bg-muted/30'
              )}
            >
              <Avatar
                src={c.visitor.avatarUrl}
                name={c.visitor.displayName ?? 'Visitor'}
                className="size-8 shrink-0 text-xs"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <PriorityDot priority={c.priority} />
                    <span className="truncate text-sm font-medium">
                      {c.visitor.displayName ?? 'Visitor'}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {relativeTime(c.lastMessageAt)}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {c.lastMessagePreview ?? c.subject ?? 'No messages yet'}
                </p>
                {(c.channel !== 'live_chat' || c.tags.length > 0) && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {c.channel !== 'live_chat' && <ChannelBadge channel={c.channel} />}
                    {c.tags.map((t) => (
                      <TagChip
                        key={t.id}
                        name={t.name}
                        color={t.color}
                        className="px-1.5 py-0 text-[10px]"
                      />
                    ))}
                  </div>
                )}
              </div>
              {c.unreadCount > 0 && (
                <span className="mt-1 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                  {c.unreadCount}
                </span>
              )}
            </button>
          ))
        )}
      </ScrollArea>
    </div>
  )
}
