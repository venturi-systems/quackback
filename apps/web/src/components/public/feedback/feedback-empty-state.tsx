import { Link } from '@tanstack/react-router'
import { FormattedMessage } from 'react-intl'
import { Button } from '@/components/ui/button'
import { isAdmin, isTeamMember, type Role } from '@/lib/shared/roles'

interface FeedbackEmptyStateProps {
  authenticated: boolean
  role: Role | null | undefined
  onSignIn?: () => void
}

/** Authentication never implies staff privileges. Unknown roles fail closed. */
export function FeedbackEmptyState({ authenticated, role, onSignIn }: FeedbackEmptyStateProps) {
  const canManage = authenticated && isTeamMember(role)
  return (
    <section className="portal-shell py-10" aria-labelledby="feedback-empty-title">
      <h1 id="feedback-empty-title" className="text-3xl mb-3">
        <FormattedMessage id="portal.feedback.empty.title" defaultMessage="No boards available" />
      </h1>
      <p className="max-w-prose text-muted-foreground">
        {canManage ? (
          <FormattedMessage
            id="portal.feedback.empty.team"
            defaultMessage="There are no feedback boards available. Configure a board before inviting people to contribute."
          />
        ) : authenticated ? (
          <FormattedMessage
            id="portal.feedback.empty.member"
            defaultMessage="No feedback boards are available to your account. Ask the Venturi team if you expected access, or check the published roadmap."
          />
        ) : (
          <FormattedMessage
            id="portal.feedback.empty.visitor"
            defaultMessage="No feedback boards are visible here yet. Sign in to see boards available to your account, or check the published roadmap."
          />
        )}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {canManage ? (
          <>
            <Button asChild>
              <Link to="/admin/feedback">
                <FormattedMessage
                  id="portal.feedback.empty.manage"
                  defaultMessage="Manage feedback"
                />
              </Link>
            </Button>
            {isAdmin(role) && (
              <Button asChild variant="outline">
                <Link to="/admin/settings/boards">
                  <FormattedMessage
                    id="portal.feedback.empty.boards"
                    defaultMessage="Configure boards"
                  />
                </Link>
              </Button>
            )}
          </>
        ) : (
          <>
            {!authenticated && onSignIn && (
              <Button type="button" onClick={onSignIn}>
                <FormattedMessage id="portal.header.auth.logIn" defaultMessage="Log in" />
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to="/roadmap">
                <FormattedMessage
                  id="portal.feedback.empty.roadmap"
                  defaultMessage="View roadmap"
                />
              </Link>
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
