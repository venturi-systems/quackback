/**
 * Sign-in page for a portal that requires sign-in to read.
 *
 * Rendered in place (HTTP 200) when the visitor may not read the portal yet.
 * Portal chrome, boards, posts and roadmap content are not rendered before
 * access is granted. The page is a left-aligned public page with the Venturi
 * header and footer that says what the portal is, who can read it, and who
 * can do what, next to the sign-in form.
 *
 * Two variants:
 *   - unauthenticated: explanation, the shared portal auth form, and the
 *     who-can-do-what summary.
 *   - unauthorized: the signed-in account has no access; explanation and a
 *     sign-out action.
 *
 * After a successful sign-in the router is invalidated so the _portal loader
 * re-runs; if the visitor is now authorized, the real portal replaces this.
 */
import { useState, useEffect, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { FormattedMessage } from 'react-intl'
import { toast } from 'sonner'
import { ArrowPathIcon } from '@heroicons/react/24/solid'
import { Button } from '@/components/ui/button'
import { PortalAuthFormInline } from '@/components/auth/portal-auth-form-inline'
import { headerForStep } from '@/components/auth/auth-step-header'
import type { AuthFormStep } from '@/components/auth/email-signin-types'
import { useAuthBroadcast } from '@/lib/client/hooks/use-auth-broadcast'
import { signOut } from '@/lib/client/auth-client'
import { isSafeCallbackUrl } from '@/lib/shared/routing'
import { navigateAfterAuth } from '@/lib/client/post-auth-navigation'
import { PortalIntlProvider } from '@/components/portal-intl-provider'
import { PublicPageFrame } from '@/components/public/shell/public-page-frame'
import { PortalRolesExplainer } from '@/components/portal/portal-roles-explainer'
import { DEFAULT_LOCALE } from '@/lib/shared/i18n'
import type { PortalAccessGateError } from '@/lib/shared/types/portal-gate-error'

// ── Types ────────────────────────────────────────────────────────────────────

// Re-exported so existing `import type { PortalAccessGateError } from
// '@/components/portal/portal-access-gate'` imports keep working.
export type { PortalAccessGateError } from '@/lib/shared/types/portal-gate-error'

// ── Inner card ────────────────────────────────────────────────────────────────

interface GateCardProps {
  reason: 'unauthenticated' | 'unauthorized'
  /** Portal read posture; drives the "who can read" sentence. */
  visibility?: PortalAccessGateError['visibility']
  workspaceName: string
  authConfig: PortalAccessGateError['authConfig']
  /** Signed-in visitor's email when reason === 'unauthorized'. */
  userEmail?: string | null
  callbackUrl?: string
  /** Seeds the form's initial mode (e.g. ?auth=signup → start on sign-up). */
  autoOpenSignin?: 'login' | 'signup'
}

function GateCard({
  reason,
  visibility,
  workspaceName,
  authConfig,
  userEmail,
  callbackUrl,
  autoOpenSignin,
}: GateCardProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [signingOut, setSigningOut] = useState(false)
  // Guard: only propagate a callback URL that passes the same-origin safety
  // check — never trust the prop directly at the navigation site.
  const safeCallback = isSafeCallbackUrl(callbackUrl) ? callbackUrl : undefined

  // The embedded form's mode (login/signup) and current step. Mode seeds from
  // the ?auth prompt; the form drives both via onModeSwitch / onContextChange.
  const [mode, setMode] = useState<'login' | 'signup'>(autoOpenSignin ?? 'login')
  const [stepCtx, setStepCtx] = useState<{ step: AuthFormStep; email: string }>({
    step: 'credentials',
    email: '',
  })

  // A one-way latch: true from a successful sign-in until this gate unmounts.
  // The gate stays mounted during the post-login loader re-run, so it shows a
  // "Signing in…" state instead of flashing the auth form back — the same window
  // PortalHeader bridges (#249). We deliberately never clear it: once auth
  // succeeds the gate either unmounts (access granted) or re-renders into the
  // unauthorized branch, so the form is never needed again.
  const [signingIn, setSigningIn] = useState(false)

  // The 2FA-abandon revoke (below) reads these from a cleanup that runs once on
  // unmount, so it needs the latest values mirrored into refs that don't
  // re-subscribe the effect.
  const stepRef = useRef<AuthFormStep>('credentials')
  const signingInRef = useRef(false)
  useEffect(() => {
    stepRef.current = stepCtx.step
  }, [stepCtx.step])
  useEffect(() => {
    signingInRef.current = signingIn
  }, [signingIn])

  // Parity with the auth dialog's abandon path: a required-2FA visitor who signs
  // in with a password has a live session before completing the second factor.
  // The dialog revokes it on close; the inline form has no close, so revoke when
  // the gate unmounts mid-2FA. Skipped once signingIn latches — that unmount is
  // a *successful* completion being granted access, not an abandon.
  useEffect(() => {
    return () => {
      const step = stepRef.current
      const midTwoFactor = step === 'two-factor-enroll' || step === 'two-factor-challenge'
      if (midTwoFactor && !signingInRef.current) {
        void signOut().catch(() => {})
      }
    }
  }, [])

  // A successful sign-in (same-tab inline via postAuthSuccess, OAuth popup, or
  // another tab) re-runs the loader to re-evaluate access. A broadcast only
  // fires on a real sign-in, so `reason` always moves off 'unauthenticated'.
  useAuthBroadcast({
    onSuccess: () => {
      setSigningIn(true)
      if (safeCallback) {
        // Team surfaces full-navigate (re-bootstrap the admin shell); a
        // portal-local destination invalidates so the gate clears, then routes.
        navigateAfterAuth(safeCallback, () => {
          void router.invalidate().then(() => router.navigate({ to: safeCallback }))
        })
      } else {
        // No pending destination — invalidate so the loader re-runs and the gate
        // clears now that the visitor is authorized.
        void router.invalidate()
      }
    },
  })

  // Sign out + invalidate so the gate re-evaluates as unauthenticated and
  // the visitor can sign back in with a different account. Mirrors the
  // portal-header sign-out path so cookie + cache + router stay in sync.
  //
  // All invalidations are awaited so the spinner doesn't clear before
  // the loader has actually re-run — otherwise the gate keeps showing
  // the old userEmail message with a re-enabled Sign-out button for a
  // visible frame. The signOut call itself is wrapped in catch so a
  // CSRF / network failure surfaces a toast instead of silently
  // bouncing back to the same screen.
  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    try {
      await signOut()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['portal', 'post'] }),
        queryClient.invalidateQueries({ queryKey: ['votedPosts'] }),
        router.invalidate(),
      ])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign out failed. Please try again.')
    } finally {
      setSigningOut(false)
    }
  }

  const header = headerForStep(mode, stepCtx, {
    surface: 'private-portal',
    workspaceName,
    visibility,
  })
  // The base step explains the portal; later steps (email code, password
  // reset) show that step's own description instead.
  const isBaseStep = stepCtx.step === 'credentials'
  const anyoneCanRead = visibility === 'authenticated'

  if (reason === 'unauthorized') {
    return (
      <div className="portal-gate__intro">
        <h1 className="portal-gate__title">
          <FormattedMessage
            id="portal.gate.noAccessTitle"
            defaultMessage="This account has no access"
          />
        </h1>
        <p className="portal-gate__lead">
          {userEmail ? (
            <FormattedMessage
              id="portal.gate.noAccessSignedInAs"
              defaultMessage="You are signed in as {email}. This portal is private, and that account is not on its access list."
              values={{ email: <strong className="portal-gate__email">{userEmail}</strong> }}
            />
          ) : (
            <FormattedMessage
              id="portal.gate.noAccessGeneric"
              defaultMessage="This portal is private, and your account is not on its access list."
            />
          )}
        </p>
        <p className="portal-gate__lead">
          <FormattedMessage
            id="portal.gate.noAccessNext"
            defaultMessage="Ask the {workspace} team for access, or sign out and use another account."
            values={{ workspace: workspaceName || 'Venturi' }}
          />
        </p>
        <div className="portal-gate__actions">
          <Button variant="outline" onClick={() => void handleSignOut()} disabled={signingOut}>
            {signingOut ? (
              <ArrowPathIcon className="mr-2 h-3 w-3 animate-spin" aria-hidden />
            ) : null}
            <FormattedMessage id="portal.gate.signOut" defaultMessage="Sign out" />
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="portal-gate__layout">
      <div className="portal-gate__intro">
        <h1 className="portal-gate__title">{header.title}</h1>
        {isBaseStep ? (
          <p className="portal-gate__lead" data-testid="portal-gate-lead">
            {anyoneCanRead ? (
              <FormattedMessage
                id="portal.gate.leadOpen"
                defaultMessage="Share product ideas, vote on requests and follow the roadmap. Anyone who signs in can read and take part."
              />
            ) : (
              <FormattedMessage
                id="portal.gate.leadPrivate"
                defaultMessage="Share product ideas, vote on requests and follow the roadmap. This portal is private: only people given access can read it."
              />
            )}
          </p>
        ) : (
          <p className="portal-gate__lead">{header.description}</p>
        )}
      </div>

      <section className="portal-gate__signin" aria-label="Sign in">
        {signingIn ? (
          <div className="portal-gate__signing-in" aria-live="polite">
            <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
            <FormattedMessage id="portal.auth.signingIn" defaultMessage="Signing in..." />
          </div>
        ) : (
          <PortalAuthFormInline
            mode={mode}
            authConfig={authConfig}
            workspaceName={workspaceName}
            callbackUrl={safeCallback}
            onModeSwitch={setMode}
            onContextChange={setStepCtx}
          />
        )}
      </section>

      {isBaseStep && (
        <div className="portal-gate__roles">
          <PortalRolesExplainer visibility={visibility} />
        </div>
      )}
    </div>
  )
}

// ── Public export ─────────────────────────────────────────────────────────────

export interface PortalAccessGateProps
  extends
    Omit<GateCardProps, 'authConfig'>,
    Pick<
      PortalAccessGateError,
      'authConfig' | 'themeStyles' | 'customCss' | 'userEmail' | 'locale' | 'logoUrl'
    > {}

export function PortalAccessGate({
  reason,
  visibility,
  workspaceName,
  authConfig,
  themeStyles,
  customCss,
  userEmail,
  locale,
  callbackUrl,
  autoOpenSignin,
}: PortalAccessGateProps) {
  return (
    // The gate renders from the _portal loader's gate branch, which does not
    // mount the portal's PortalIntlProvider. The embedded auth form uses
    // react-intl, so the gate provides its own provider; without it
    // <FormattedMessage> has no context and crashes. No SSR catalog here;
    // useIntlSetup fetches it client-side, well before the form needs it.
    <PortalIntlProvider locale={locale ?? DEFAULT_LOCALE}>
      {/* Keep the sign-in page visually consistent with the portal. */}
      {themeStyles && <style dangerouslySetInnerHTML={{ __html: themeStyles }} />}
      {customCss && <style dangerouslySetInnerHTML={{ __html: customCss }} />}
      <PublicPageFrame className="portal-gate">
        <GateCard
          reason={reason}
          visibility={visibility}
          workspaceName={workspaceName}
          authConfig={authConfig}
          userEmail={userEmail}
          callbackUrl={callbackUrl}
          autoOpenSignin={autoOpenSignin}
        />
      </PublicPageFrame>
    </PortalIntlProvider>
  )
}
