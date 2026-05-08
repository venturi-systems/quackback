/**
 * Registered-providers introspection — used by BootstrapData to drive
 * admin login UI decisions (e.g. "show SSO as the default CTA only if
 * it's actually wired up at the auth layer").
 *
 * The registration-truth source is `createAuth()` in `index.ts`. Two
 * places decide whether a provider can sign anyone in:
 * 1. The env-baked / DB-baked SSO_OIDC trio (provider id `sso`)
 * 2. The platform_credentials table for the providers in
 *    AUTH_PROVIDERS — gated by tier-limits.features.customOidcProvider
 *    for the generic-oauth ones.
 *
 * This helper duplicates that logic just enough to answer "which
 * providers would Better-Auth register if it booted right now?"
 * Critically, it returns the actually-usable set rather than the DB
 * intent: a stale `settings.authConfig.ssoOidc.enabled=true` with no
 * SSO_OIDC_CLIENT_SECRET in env is NOT reported as registered, because
 * Better-Auth would reject it at boot.
 */

import { getTenantSettings } from '@/lib/server/domains/settings/settings.service'
import { getTierLimits } from '@/lib/server/domains/settings/tier-limits.service'
import { getAllAuthProviders } from './auth-providers'

export async function getRegisteredAuthProviders(): Promise<string[]> {
  const ids: string[] = []

  // SSO is registered when EITHER (a) DB says enabled AND env has the
  // client secret, or (b) the env trio is fully set on its own.
  const tenantSettings = await getTenantSettings()
  const ssoFromDb = tenantSettings?.authConfig?.ssoOidc
  const hasClientSecret = Boolean(process.env.SSO_OIDC_CLIENT_SECRET)
  const dbWantsSso = Boolean(ssoFromDb?.enabled)
  const envHasSso = Boolean(
    process.env.SSO_OIDC_DISCOVERY_URL &&
    process.env.SSO_OIDC_CLIENT_ID &&
    process.env.SSO_OIDC_CLIENT_SECRET
  )
  if ((dbWantsSso && hasClientSecret) || envHasSso) {
    ids.push('sso')
  }

  // Built-in social + custom generic-oauth providers gated by
  // platform_credentials having both clientId + clientSecret. The auth
  // layer also gates generic-oauth on the customOidcProvider tier flag,
  // so mirror that here.
  const { getPlatformCredentials } =
    await import('@/lib/server/domains/platform-credentials/platform-credential.service')
  const tierLimits = await getTierLimits()
  for (const provider of getAllAuthProviders()) {
    const creds = await getPlatformCredentials(provider.credentialType)
    if (!creds?.clientId || !creds?.clientSecret) continue
    if (provider.type === 'generic-oauth' && !tierLimits.features.customOidcProvider) continue
    ids.push(provider.id)
  }

  return ids
}
