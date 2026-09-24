import { useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { PublicPageFrame } from '@/components/public/shell/public-page-frame'
import { useInShell } from '@/components/public/shell/shell-context'
import { VENTURI_SITE_URL } from '@/lib/shared/venturi-identity'

interface ErrorPageProps {
  // TanStack Router types a caught route error as `unknown`: anything can be thrown.
  error: unknown
  reset?: () => void
}

/**
 * Page title for a status page. The root head sets the site title during
 * server rendering; once hydrated the tab names the condition, so a visitor
 * with several tabs (or a screen reader announcing the title) knows which
 * page failed.
 */
function useStatusTitle(title: string) {
  useEffect(() => {
    const previous = document.title
    document.title = `${title} · Venturi Feedback`
    return () => {
      document.title = previous
    }
  }, [title])
}

/**
 * Chrome for error and not-found content. Inside the portal or the admin the
 * surrounding layout already draws the header and footer, so the content
 * renders in place; on its own it gets the public page frame.
 */
export function FriendlyShell({ children }: { children: ReactNode }) {
  const inShell = useInShell()
  const content = <section className="public-status">{children}</section>
  if (inShell) return <div className="portal-shell public-status__inline">{content}</div>
  return <PublicPageFrame>{content}</PublicPageFrame>
}

/**
 * The message of a caught route error, if it has one.
 *
 * Route errors are typed `unknown`. An Error, or any object carrying a string
 * `message`, yields that message; anything else (a thrown string, null) yields
 * undefined, so the caller shows no technical details instead of crashing.
 */
export function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error as { message: unknown }
    return typeof message === 'string' ? message : undefined
  }
  return undefined
}

/**
 * True for the role-gate failures thrown by requireAuth / requireWorkspaceRole
 * (e.g. "Access denied: Requires [admin], got member"). These are expected
 * outcomes, not crashes, so they get a calm permission notice rather than the
 * generic error treatment, and the raw role-gate text never reaches the page.
 * (Upstream v0.13.0, 71b6c8f6c.)
 */
export function isAuthorizationError(error: unknown): boolean {
  const message = errorMessage(error)
  return message !== undefined && /access denied/i.test(message)
}

const PERMISSION_DENIED_TITLE = 'Access denied'

function PermissionDeniedContent() {
  return (
    <FriendlyShell>
      <h1 className="public-status__title">You don't have access to this page</h1>
      <p className="public-status__lead">
        This area is limited to team members with the required role. If you think that's a
        mistake, ask an administrator for access.
      </p>

      <div className="public-status__actions">
        <Button size="lg" variant="outline" asChild>
          <a href="/">Go to feedback home</a>
        </Button>
      </div>
    </FriendlyShell>
  )
}

export function PermissionDeniedPage() {
  useStatusTitle(PERMISSION_DENIED_TITLE)
  return <PermissionDeniedContent />
}

export function DefaultErrorPage({ error, reset }: ErrorPageProps) {
  const message = errorMessage(error)
  const denied = isAuthorizationError(error)
  // One title per page: decided here, not in a child, because a child's effect
  // runs before this one and would be overwritten.
  useStatusTitle(denied ? PERMISSION_DENIED_TITLE : 'Page could not load')
  if (denied) return <PermissionDeniedContent />
  return (
    <FriendlyShell>
      <h1 className="public-status__title">This page could not load</h1>
      <p className="public-status__lead">
        An unexpected error stopped it. Try again, or return to the feedback home page.
      </p>

      {message && (
        <details className="public-status__details">
          <summary>Technical details</summary>
          <p>
            <code>{message}</code>
          </p>
        </details>
      )}

      <div className="public-status__actions">
        {reset && (
          <Button size="lg" onClick={reset}>
            Try again
          </Button>
        )}
        <Button size="lg" variant="outline" asChild>
          <a href="/">Go to feedback home</a>
        </Button>
      </div>
    </FriendlyShell>
  )
}

export function NotFoundPage() {
  useStatusTitle('Page not found')
  return (
    <FriendlyShell>
      <h1 className="public-status__title">Page not found</h1>
      <p className="public-status__lead">
        The link may be out of date, or the page may have moved.
      </p>

      <div className="public-status__actions">
        <Button size="lg" asChild>
          <a href="/">Go to feedback home</a>
        </Button>
        <Button size="lg" variant="outline" asChild>
          <a href={VENTURI_SITE_URL}>Go to venturi.systems</a>
        </Button>
      </div>
    </FriendlyShell>
  )
}
