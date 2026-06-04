import { FormattedMessage } from 'react-intl'
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import { chatAvailable } from '@/lib/shared/chat/presence'
import { useChatSummary } from './use-chat-summary'
import { WidgetResumeCard } from './widget-resume-card'
import { WidgetConversationHistory } from './widget-conversation-history'
import { ChatPresenceBadge } from './chat-presence-badge'

interface WidgetMessagesSectionProps {
  /** Open the full-height chat thread. */
  onOpenChat: () => void
}

/**
 * The "Messages" half of the combined support surface: a resume card for any
 * in-flight conversation plus a primary CTA into the chat thread. Rendered
 * below the help articles when live chat is part of the support surface.
 */
export function WidgetMessagesSection({ onOpenChat }: WidgetMessagesSectionProps) {
  const { conversation, teamName, agentsOnline, withinOfficeHours } = useChatSummary(true)
  const available = chatAvailable(agentsOnline, withinOfficeHours)

  return (
    <div className="mt-4 border-t border-border/40 pt-3">
      <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
        <FormattedMessage id="widget.messages.heading" defaultMessage="Messages" />
      </p>

      {conversation && (
        <div className="mb-2">
          <WidgetResumeCard
            conversation={conversation}
            teamName={teamName}
            agentsOnline={agentsOnline}
            onClick={onOpenChat}
          />
        </div>
      )}

      {/* Only offer the "start a message" entry point when there's no active
          conversation — an in-flight thread already surfaces its own resume card
          above, so a second "continue" button would just duplicate it. */}
      {!conversation && (
        <button
          type="button"
          onClick={onOpenChat}
          className="w-full flex items-center gap-2.5 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-start hover:bg-muted/40 transition-colors"
        >
          <ChatBubbleLeftRightIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-foreground">
              <FormattedMessage id="widget.messages.start" defaultMessage="Send us a message" />
            </span>
            <ChatPresenceBadge available={available} className="mt-0.5" />
          </span>
        </button>
      )}

      <WidgetConversationHistory activeId={conversation?.id} />
    </div>
  )
}
