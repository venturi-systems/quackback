/**
 * Shape of the portal access-gate, returned as loader data by `_portal.tsx`
 * when a visitor is unauthenticated/unauthorized. Lives in lib/shared so it can
 * be imported without React or router deps.
 */

import type { SupportedLocale } from '@/lib/shared/i18n'

export interface PortalAccessGateError {
  /** Discriminant identifying the gate in the loader data. */
  type: 'portal-access-gate'
  reason: 'unauthenticated' | 'unauthorized'
  /**
   * The portal's read posture, so the sign-in page can say who may read:
   * `authenticated` = anyone who signs in, `private` = only people given
   * access. Optional for older payloads; the page then assumes `private`.
   */
  visibility?: 'public' | 'authenticated' | 'private'
  workspaceName: string
  logoUrl: string | null
  themeStyles: string
  customCss: string
  /**
   * Locale resolved server-side (Accept-Language) so the gate's auth dialog
   * renders under the same PortalIntlProvider the portal uses. Optional: older
   * serialized payloads omit it, and the gate falls back to the default locale.
   */
  locale?: SupportedLocale
  /**
   * The signed-in visitor's email when reason === 'unauthorized'. Lets the
   * overlay tell the visitor exactly which account is being blocked so they
   * can sign out and try a different one (typical case: signed in with a
   * personal Gmail when the portal allows @acme.com only). Null/undefined
   * when reason === 'unauthenticated' — no session means no email to show.
   */
  userEmail?: string | null
  /** Pending destination to navigate to once access is granted post-sign-in. */
  callbackUrl?: string
  /** When set, the gate opens the sign-in dialog automatically on mount. */
  autoOpenSignin?: 'login' | 'signup'
  /**
   * The `?error=` code of a refused sign-in or access redirect, such as
   * `not_team_member`. The gate shows its message only for a known code
   * (`authBlockMessage`, own keys only); anything else shows nothing.
   */
  error?: string
  authConfig: {
    found: boolean
    oauth: Record<string, boolean | undefined>
    oidcProviders?: { id: string; name: string }[]
    /** All registered auth provider ids — lets the gate's sign-in form show
     *  the email input for a routed-only IdP that renders no public button. */
    registeredAuthProviders?: string[]
    /** Workspace requires 2FA — drives inline enrollment after password sign-in. */
    twoFactorRequired?: boolean
  }
}
