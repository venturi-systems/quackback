import { useEffect, useState } from 'react'
import { FormattedMessage } from 'react-intl'
import { useRouteContext } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { useAuthPopoverSafe } from '@/components/auth/auth-popover-context'
import { hasAnyPortalAuthMethod, resolveSoleOidcProvider } from '@/components/auth/oauth-buttons'
import { authClient } from '@/lib/client/auth-client'

/** Anchor the composer carries; a sign-in that starts here returns to it. */
export const COMPOSER_ANCHOR = 'feedback-composer'

/** Current page plus the composer anchor, as a same-origin relative URL. */
function composerCallbackUrl(): string {
  if (typeof window === 'undefined') return `/#${COMPOSER_ANCHOR}`
  return `${window.location.pathname}${window.location.search}#${COMPOSER_ANCHOR}`
}

/**
 * Shown in place of the composer to a signed-out visitor who could post after
 * signing in. One 44px action opens the sign-in dialog; the callback URL points
 * back at the composer so an OAuth round trip lands where the visitor started.
 * Nothing is typed before sign-in, so there is no draft to lose.
 */
export function ShareIdeaSignIn() {
  const { settings, registeredAuthProviders } = useRouteContext({ from: '__root__' })
  const authPopover = useAuthPopoverSafe()
  const oauth = settings?.publicAuthConfig?.oauth ?? {}
  const canSignIn = hasAnyPortalAuthMethod(oauth, {
    registeredAuthProviders,
    oidcProviders: settings?.publicPortalConfig?.oidcProviders,
  })
  const soleOidcProviderId = resolveSoleOidcProvider(registeredAuthProviders, oauth)

  if (!canSignIn) return <ShareIdeaUnavailable signedIn={false} reason="no-sign-in" />

  const startSignIn = () => {
    const callbackUrl = composerCallbackUrl()
    // Mark the return point in this tab too: a dialog sign-in (no redirect)
    // re-renders the feed in place, and the composer opens itself when it
    // mounts at this anchor.
    window.history.replaceState(window.history.state, '', callbackUrl)
    if (soleOidcProviderId) {
      void authClient.signIn.oauth2({ providerId: soleOidcProviderId, callbackURL: callbackUrl })
      return
    }
    if (authPopover) {
      authPopover.openAuthPopover({ mode: 'login', callbackUrl })
      return
    }
    // No dialog on this surface: the portal layout opens it from ?auth=signin.
    window.location.assign(`/?auth=signin&callbackUrl=${encodeURIComponent(callbackUrl)}`)
  }

  return (
    <section id={COMPOSER_ANCHOR} className="share-idea share-idea--sign-in">
      <p className="share-idea__note">
        <FormattedMessage
          id="portal.feedback.shareIdea.signInNote"
          defaultMessage="Posting an idea needs a signed-in account."
        />
      </p>
      <Button type="button" size="lg" onClick={startSignIn}>
        <FormattedMessage
          id="portal.feedback.shareIdea.signIn"
          defaultMessage="Sign in to share an idea"
        />
      </Button>
    </section>
  )
}

/**
 * Shown when nobody the viewer could become by signing in may post on the
 * listed boards, or when a signed-in viewer's own access denies every board.
 */
export function ShareIdeaUnavailable({
  signedIn,
  reason = 'restricted',
  singleBoard = false,
}: {
  signedIn: boolean
  reason?: 'restricted' | 'no-sign-in'
  /** True on one board's feed: the note speaks about "this board". */
  singleBoard?: boolean
}) {
  return (
    <section id={COMPOSER_ANCHOR} className="share-idea share-idea--unavailable" role="note">
      <p className="share-idea__note">
        {reason === 'no-sign-in' ? (
          <FormattedMessage
            id="portal.feedback.shareIdea.noSignIn"
            defaultMessage="Posting an idea needs an account, and sign-in is not available here."
          />
        ) : signedIn ? (
          singleBoard ? (
            <FormattedMessage
              id="portal.feedback.shareIdea.noAccessSignedInBoard"
              defaultMessage="Your account can read this board but cannot post ideas on it."
            />
          ) : (
            <FormattedMessage
              id="portal.feedback.shareIdea.noAccessSignedIn"
              defaultMessage="Your account can read these boards but cannot post ideas on them."
            />
          )
        ) : singleBoard ? (
          <FormattedMessage
            id="portal.feedback.shareIdea.restrictedBoard"
            defaultMessage="Posting ideas on this board is limited to specific groups or the team."
          />
        ) : (
          <FormattedMessage
            id="portal.feedback.shareIdea.restricted"
            defaultMessage="Posting ideas on these boards is limited to specific groups or the team."
          />
        )}
      </p>
    </section>
  )
}

/**
 * True once, on the client, when the page was opened at the composer anchor
 * (the return leg of a sign-in that started at "Sign in to share an idea").
 */
export function useOpenedAtComposer(): boolean {
  const [openedAtComposer, setOpenedAtComposer] = useState(false)
  useEffect(() => {
    if (window.location.hash === `#${COMPOSER_ANCHOR}`) setOpenedAtComposer(true)
  }, [])
  return openedAtComposer
}
