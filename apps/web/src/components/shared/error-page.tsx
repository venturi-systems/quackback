import type { ReactNode } from 'react'
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

export function DefaultErrorPage({ error, reset }: ErrorPageProps) {
  const message = errorMessage(error)
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
