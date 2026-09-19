/**
 * In-place privacy wall for private portals.
 *
 * Renders a focused sign-in or access-denied screen. Portal chrome, boards,
 * posts, and roadmap content are not rendered before access is granted.
 *
 * Two variants:
 *   - unauthenticated: the shared portal auth form, embedded directly as a
 *     dedicated sign-in screen (the same form public portals show in a dialog).
 *   - unauthorized: informational message, no form.
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
import { DEFAULT_LOCALE } from '@/lib/shared/i18n'
import type { PortalAccessGateError } from '@/lib/shared/types/portal-gate-error'

// ── Types ────────────────────────────────────────────────────────────────────

// Re-exported so existing `import type { PortalAccessGateError } from
// '@/components/portal/portal-access-gate'` imports keep working.
export type { PortalAccessGateError } from '@/lib/shared/types/portal-gate-error'

// ── Inner card ────────────────────────────────────────────────────────────────

interface GateCardProps {
  reason: 'unauthenticated' | 'unauthorized'
  workspaceName: string
  logoUrl: string | null
  authConfig: PortalAccessGateError['authConfig']
  /** Signed-in visitor's email when reason === 'unauthorized'. */
  userEmail?: string | null
  callbackUrl?: string
  /** Seeds the form's initial mode (e.g. ?auth=signup → start on sign-up). */
  autoOpenSignin?: 'login' | 'signup'
}

function GateCard({
  reason,
  workspaceName,
  logoUrl,
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

  const header = headerForStep(mode, stepCtx, { surface: 'private-portal', workspaceName })

  return (
    <div className="rounded-xl border bg-card shadow-lg p-8 w-full max-w-md text-center space-y-4">
      {/* Org logo, or the workspace initial as a branded fallback (matches
          the portal header — never a generic icon). */}
      {logoUrl ? (
        <img src={logoUrl} alt={workspaceName} className="mx-auto h-12 w-auto object-contain" />
      ) : (
        <div className="mx-auto flex h-12 w-12 items-center justify-center [border-radius:calc(var(--radius)*0.6)] bg-primary text-lg font-semibold text-primary-foreground">
          {workspaceName.charAt(0).toUpperCase()}
        </div>
      )}

      {reason === 'unauthenticated' ? (
        signingIn ? (
          <div
            className="flex h-9 items-center justify-center gap-2 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <ArrowPathIcon className="h-4 w-4 animate-spin" aria-hidden="true" />
            <FormattedMessage id="portal.auth.signingIn" defaultMessage="Signing in..." />
          </div>
        ) : (
          <>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{header.title}</h1>
              <p className="mt-2 text-sm text-muted-foreground">{header.description}</p>
            </div>
            <div className="text-left">
              <PortalAuthFormInline
                mode={mode}
                authConfig={authConfig}
                workspaceName={workspaceName}
                callbackUrl={safeCallback}
                onModeSwitch={setMode}
                onContextChange={setStepCtx}
              />
            </div>
          </>
        )
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">You don&apos;t have access</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {userEmail ? (
                <>
                  You&apos;re signed in as{' '}
                  <span className="font-medium text-foreground">{userEmail}</span>, but this account
                  isn&apos;t on the access list for this private portal.
                </>
              ) : (
                <>This portal is private and your account isn&apos;t on the access list.</>
              )}{' '}
              Reach out to the {workspaceName} team to request access, or sign out and try a
              different account.
            </p>
          </div>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut ? <ArrowPathIcon className="mr-2 h-3 w-3 animate-spin" /> : null}
            Sign out
          </Button>
        </>
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
      'authConfig' | 'themeStyles' | 'customCss' | 'userEmail' | 'locale'
    > {}

export function PortalAccessGate({
  reason,
  workspaceName,
  logoUrl,
  authConfig,
  themeStyles,
  customCss,
  userEmail,
  locale,
  callbackUrl,
  autoOpenSignin,
}: PortalAccessGateProps) {
  return (
    // The gate renders on the route's error path (a beforeLoad throw), which
    // skips the loader that mounts PortalIntlProvider for the normal portal.
    // The embedded auth form uses react-intl, so the gate provides its own
    // provider — without it <FormattedMessage> has no context and crashes.
    // No SSR catalog here (the error path has no loader data); useIntlSetup
    // fetches it client-side, which lands well before the form needs it.
    <PortalIntlProvider locale={locale ?? DEFAULT_LOCALE}>
      <div className="min-h-screen bg-background">
        {/* Keep the authenticated perimeter visually consistent with the portal. */}
        {themeStyles && <style dangerouslySetInnerHTML={{ __html: themeStyles }} />}
        {customCss && <style dangerouslySetInnerHTML={{ __html: customCss }} />}
        <main className="flex min-h-screen items-center justify-center px-4 py-8 sm:py-12">
          <GateCard
            reason={reason}
            workspaceName={workspaceName}
            logoUrl={logoUrl}
            authConfig={authConfig}
            userEmail={userEmail}
            callbackUrl={callbackUrl}
            autoOpenSignin={autoOpenSignin}
          />
        </main>
      </div>
    </PortalIntlProvider>
  )
}
