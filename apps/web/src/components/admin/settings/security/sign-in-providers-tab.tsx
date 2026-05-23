import { useState, useTransition } from 'react'
import { useRouter, useRouteContext } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowPathIcon,
  EnvelopeIcon,
  KeyIcon,
  LockClosedIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/solid'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MethodRow } from '@/components/admin/settings/auth-shared/method-row'
import { OAuthProviderGrid } from '@/components/admin/settings/auth-shared/oauth-provider-grid'
import { AuthProviderCredentialsDialog } from '@/components/admin/settings/portal-auth/auth-provider-credentials-dialog'
import { SettingsCard } from '@/components/admin/settings/settings-card'
import { WarningBox } from '@/components/shared/warning-box'
import { AUTH_PROVIDERS } from '@/lib/shared/auth-providers'
import { isPathManagedFromBootstrap } from '@/lib/client/config-file'
import { updateAuthConfigFn, updatePortalConfigFn } from '@/lib/server/functions/settings'
import { cn } from '@/lib/shared/utils'
import type { AuthConfig, PortalAuthMethods, PortalConfig } from '@/lib/shared/types/settings'

interface SignInProvidersTabProps {
  /** Team-side auth config from settings.authConfig. */
  initialTeamAuthConfig: AuthConfig
  /** Portal-side oauth/methods from settings.portalConfig.oauth. */
  initialPortalOauth: PortalAuthMethods
  portalConfig: PortalConfig
  credentialStatus: Record<string, boolean> & { _emailConfigured?: boolean }
  customOidcProviderTier: boolean
}

/**
 * Sign-in providers tab — the third top-level tab on /authentication.
 *
 * One toggle per provider. SSO enforcement on /sso is the team-side
 * lockdown; any enabled provider here is a valid entry path for both
 * the portal and the admin team sign-in (subject to the access rules
 * on the Portal access tab + SSO enforcement on the Team access tab).
 *
 * Migration nuance:
 *  - For `password` and `magicLink` the data model still has separate
 *    flags on `auth.oauth.*` (team) and `portalConfig.oauth.*` (portal).
 *    The UI shows ONE toggle that reads as OR(team, portal) and writes
 *    to BOTH — never *removes* a working sign-in path on save, only
 *    promotes the more-permissive value into the unified slot.
 *  - For social providers and Custom OIDC the schema only has the
 *    portal flag today, so the unified toggle just maps onto it.
 *    Enabling Google here implicitly enables it for the team sign-in
 *    surface too, which is a new capability that previously required
 *    SSO setup.
 */
export function SignInProvidersTab({
  initialTeamAuthConfig,
  initialPortalOauth,
  portalConfig: _portalConfig,
  credentialStatus,
  customOidcProviderTier,
}: SignInProvidersTabProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [isPending, startTransition] = useTransition()
  const [saving, setSaving] = useState(false)

  const { managedFieldPaths = [] } =
    (useRouteContext({ from: '__root__' }) as { managedFieldPaths?: string[] }) ?? {}
  const isManaged = (path: string) => isPathManagedFromBootstrap(path, managedFieldPaths)

  // ---------- Unified state ----------
  // Built-in methods (password, magic link): seed from OR of team + portal
  // so existing asymmetric tenants land on the more-permissive value.
  const [teamAuthConfig, setTeamAuthConfig] = useState<AuthConfig>(initialTeamAuthConfig)
  const teamOauth = (teamAuthConfig.oauth ?? {}) as Record<string, boolean | undefined>

  const [oauthState, setOauthState] = useState<Record<string, boolean | undefined>>(() => ({
    ...initialPortalOauth,
    // For built-ins, OR the two surfaces — show "on" if either side has
    // it. Subsequent writes go to both surfaces simultaneously.
    password: teamOauth.password !== false || initialPortalOauth.password === true,
    magicLink: teamOauth.magicLink !== false || initialPortalOauth.magicLink === true,
  }))

  const emailConfigured = credentialStatus._emailConfigured !== false
  const passwordEnabled = !!oauthState.password
  const magicLinkEnabled = !!oauthState.magicLink

  /** "Last method standing" guard — refuses to disable the only enabled
   *  provider so visitors aren't locked out. Counts configured+enabled
   *  OAuth providers in addition to password + magic link. The legacy
   *  `email` flag is excluded (migration 0049 retired it). */
  const enabledMethodCount = Object.entries(oauthState).reduce((acc, [id, enabled]) => {
    if (!enabled) return acc
    if (id === 'email') return acc
    if (id === 'password' || id === 'magicLink') return acc + 1
    return credentialStatus[id] ? acc + 1 : acc
  }, 0)
  const isLastMethod = (id: string) => !!oauthState[id] && enabledMethodCount === 1

  /** Gate on what's actually *usable*: a `google: true` flag with no
   *  saved credential is shown as "Not configured" and doesn't count.
   *  When everything is off (or off + unusable), surface the warning
   *  banner — admins would otherwise have a portal that no one can
   *  sign into. */
  const noAuthEnabled = (() => {
    if (oauthState.password) return false
    if (oauthState.magicLink && emailConfigured) return false
    return !Object.entries(oauthState).some(([id, enabled]) => {
      if (!enabled) return false
      if (id === 'password' || id === 'magicLink' || id === 'email') return false
      return !!credentialStatus[id]
    })
  })()

  // ---------- Save fan-out ----------
  /**
   * Toggling password / magic link writes to BOTH the team auth config
   * and the portal oauth config in parallel. Both writes are required
   * for the unified flag semantics; partial success would leave the two
   * surfaces inconsistent (the very thing we're collapsing away from),
   * so we wait for both and revert on either failure.
   */
  const saveBuiltin = async (key: 'password' | 'magicLink', value: boolean) => {
    setSaving(true)
    const prevTeam = teamAuthConfig
    const prevOauth = oauthState
    setOauthState((p) => ({ ...p, [key]: value }))
    setTeamAuthConfig((p) => ({ ...p, oauth: { ...(p.oauth ?? {}), [key]: value } }))
    try {
      const [updated] = await Promise.all([
        updateAuthConfigFn({ data: { oauth: { [key]: value } } }),
        updatePortalConfigFn({ data: { oauth: { [key]: value } } }),
      ])
      setTeamAuthConfig(updated)
      void queryClient.invalidateQueries({ queryKey: ['settings', 'authConfig'] })
      startTransition(() => router.invalidate())
      toast.success('Sign-in providers saved.')
    } catch (err) {
      // Revert both — neither surface should silently drift.
      setOauthState(prevOauth)
      setTeamAuthConfig(prevTeam)
      toast.error(err instanceof Error ? err.message : 'Could not save settings.')
    } finally {
      setSaving(false)
    }
  }

  /**
   * Toggling a social / OIDC provider writes only to the portal config
   * — that's the schema's single source of truth for those providers
   * today. The flag governs both surfaces under the unified model; the
   * route's auth handler treats it as "enabled platform-wide".
   */
  const saveOauthProvider = async (providerId: string, checked: boolean) => {
    setSaving(true)
    const prev = oauthState
    setOauthState((p) => ({ ...p, [providerId]: checked }))
    try {
      await updatePortalConfigFn({ data: { oauth: { [providerId]: checked } } })
      startTransition(() => router.invalidate())
    } catch (err) {
      setOauthState(prev)
      toast.error(err instanceof Error ? err.message : 'Could not save settings.')
    } finally {
      setSaving(false)
    }
  }

  // ---------- Credentials dialog (shared across all providers) ----------
  const [configDialog, setConfigDialog] = useState<{
    credentialType: string
    providerId: string
    providerName: string
    helpUrl?: string
    fields: (typeof AUTH_PROVIDERS)[number]['platformCredentials']
  } | null>(null)

  const openConfigDialog = (provider: (typeof AUTH_PROVIDERS)[number]) => {
    const helpUrl = provider.platformCredentials.find((f) => f.helpUrl)?.helpUrl
    setConfigDialog({
      credentialType: provider.credentialType,
      providerId: provider.id,
      providerName: provider.name,
      helpUrl,
      fields: provider.platformCredentials,
    })
  }

  const busy = saving || isPending

  return (
    <div className="space-y-6">
      {noAuthEnabled && (
        <WarningBox
          variant="warning"
          title="No sign-in method enabled"
          description={
            <>
              Visitors and team admins can&apos;t sign in. Enable at least one provider below — or
              set up SSO on the{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">/sso</code> page for the
              team.
            </>
          }
        />
      )}

      {/* Card 1: Built-in (password + magic link) — applies to both
          surfaces. Single toggle per row; saveBuiltin fans out to both
          auth.oauth.X and portalConfig.oauth.X. */}
      <SettingsCard
        title="Email"
        description="Built-in sign-in for the portal and the admin team."
        contentClassName="space-y-4"
      >
        <MethodRow
          icon={KeyIcon}
          label="Password"
          description="Sign in with email and password."
          checked={passwordEnabled}
          onCheckedChange={(v) => void saveBuiltin('password', v)}
          disabled={
            busy ||
            isManaged('auth.oauth.password') ||
            isManaged('portalConfig.oauth.password') ||
            isLastMethod('password')
          }
          badge={
            isManaged('auth.oauth.password') || isManaged('portalConfig.oauth.password')
              ? 'Managed'
              : undefined
          }
        />
        <MethodRow
          icon={EnvelopeIcon}
          label="Email magic link"
          description={
            emailConfigured
              ? 'One-click link or 6-digit code by email.'
              : 'Configure SMTP or Resend to enable email delivery.'
          }
          checked={magicLinkEnabled}
          onCheckedChange={(v) => void saveBuiltin('magicLink', v)}
          disabled={
            busy ||
            !emailConfigured ||
            isManaged('auth.oauth.magicLink') ||
            isManaged('portalConfig.oauth.magicLink') ||
            isLastMethod('magicLink')
          }
          badge={
            isManaged('auth.oauth.magicLink') || isManaged('portalConfig.oauth.magicLink')
              ? 'Managed'
              : undefined
          }
        />
      </SettingsCard>

      {/* Card 2: Social sign-in — single set of toggles for both
          surfaces. Configure credentials once; the toggle decides
          whether it shows up on portal AND admin sign-in screens. */}
      <SettingsCard
        title="Social sign-in"
        description="Let visitors and team admins sign in with Google, GitHub, and more."
      >
        <OAuthProviderGrid
          enabled={oauthState}
          credentialStatus={credentialStatus}
          isLastMethod={isLastMethod}
          isManaged={(id) => isManaged(`portalConfig.oauth.${id}`)}
          saving={busy}
          onToggle={(id, checked) => void saveOauthProvider(id, checked)}
          onConfigure={openConfigDialog}
          excludeProviderIds={['custom-oidc']}
        />
      </SettingsCard>

      {/* Card 3: Custom identity provider. The standalone team SSO
          connection still lives on /sso (linked from the Team access
          tab) — this card is the OIDC alternative for tenants who
          prefer a bring-your-own provider to the SSO plugin flow. */}
      <CustomOidcCard
        configured={!!credentialStatus['custom-oidc']}
        enabled={!!oauthState['custom-oidc']}
        managed={isManaged('portalConfig.oauth.custom-oidc')}
        lastMethod={isLastMethod('custom-oidc')}
        tierEnabled={customOidcProviderTier}
        saving={busy}
        onToggle={(v) => void saveOauthProvider('custom-oidc', v)}
        onConfigure={() => {
          const provider = AUTH_PROVIDERS.find((p) => p.id === 'custom-oidc')
          if (provider) openConfigDialog(provider)
        }}
      />

      {busy && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
          <span>Saving…</span>
        </div>
      )}

      {configDialog && (
        <AuthProviderCredentialsDialog
          open={!!configDialog}
          onOpenChange={(open) => {
            if (!open) setConfigDialog(null)
          }}
          credentialType={configDialog.credentialType}
          providerId={configDialog.providerId}
          providerName={configDialog.providerName}
          helpUrl={configDialog.helpUrl}
          fields={configDialog.fields}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CustomOidcCard — extracted from portal-auth-tab.tsx so SignInProvidersTab
// can render it without depending on the Portal access tab.
// ---------------------------------------------------------------------------

interface CustomOidcCardProps {
  configured: boolean
  enabled: boolean
  managed: boolean
  lastMethod: boolean
  tierEnabled: boolean
  saving: boolean
  onToggle: (next: boolean) => void
  onConfigure: () => void
}

function CustomOidcCard({
  configured,
  enabled,
  managed,
  lastMethod,
  tierEnabled,
  saving,
  onToggle,
  onConfigure,
}: CustomOidcCardProps) {
  const headerBadge = (() => {
    if (!tierEnabled) {
      return (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          <LockClosedIcon className="mr-1 h-2.5 w-2.5" />
          Higher tier
        </Badge>
      )
    }
    if (!configured) return null
    if (enabled) {
      return (
        <Badge
          variant="outline"
          className="border-green-500/30 text-green-600 text-[10px] px-1.5 py-0"
        >
          <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-600" />
          Active
        </Badge>
      )
    }
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
        Configured
      </Badge>
    )
  })()

  return (
    <div className="rounded-xl border border-border/50 bg-card shadow-sm">
      <div className="flex items-start gap-4 p-6">
        <div
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            tierEnabled ? 'bg-violet-600/10' : 'bg-muted'
          )}
        >
          <ShieldCheckIcon
            className={cn('h-5 w-5', tierEnabled ? 'text-violet-600' : 'text-muted-foreground/60')}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Custom identity provider</h2>
            {headerBadge}
          </div>
          <p className="mt-1 max-w-xl text-xs text-muted-foreground">
            Bring your own OIDC IdP for portal and admin sign-in. Works with Okta, Azure AD, Auth0,
            Keycloak, and more.
          </p>

          {!tierEnabled ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Available on plans with the custom OIDC feature.
            </p>
          ) : !configured ? (
            <div className="mt-4">
              <Button type="button" size="sm" onClick={onConfigure} disabled={saving || managed}>
                Set up
              </Button>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onConfigure}
                disabled={saving || managed}
              >
                Edit credentials
              </Button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => onToggle(e.target.checked)}
                  disabled={saving || managed || lastMethod}
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                <span>{enabled ? 'Enabled' : 'Disabled'}</span>
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
