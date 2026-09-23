import type {
  PortalConfig,
  PortalAccessConfig,
  TenantSettings,
} from '@/lib/server/domains/settings/settings.types'

/**
 * Raw settings-row columns that must never leave the server. `widgetSecret`
 * is the HMAC key that signs widget identity tokens (settings.widget.ts); a
 * client that reads it can forge any widget identity.
 */
const SERVER_ONLY_SETTINGS_COLUMNS = ['widgetSecret'] as const

function stripServerOnlyColumns<T>(row: T): T {
  if (!row || typeof row !== 'object') return row
  if (!SERVER_ONLY_SETTINGS_COLUMNS.some((key) => key in (row as object))) return row
  const copy = { ...(row as Record<string, unknown>) }
  for (const key of SERVER_ONLY_SETTINGS_COLUMNS) delete copy[key]
  return copy as T
}

/** Redacted access shape — visibility only. */
type RedactedAccess = Pick<PortalAccessConfig, 'visibility'>

/** Redacted PortalConfig with access stripped to visibility only. */
type RedactedPortalConfig = Omit<PortalConfig, 'access'> & { access?: RedactedAccess }

/**
 * Strips the server-only access policy fields (allowedDomains, widgetSignIn,
 * allowedSegmentIds) from a parsed PortalConfig before returning it to a
 * client-bound context. Keeps access.visibility (already public via
 * publicPortalConfig.portalAccess).
 */
function redactPortalConfig(portalConfig: PortalConfig): RedactedPortalConfig {
  if (!portalConfig.access) return portalConfig
  return {
    ...portalConfig,
    access: {
      // Only expose visibility — allowedDomains, widgetSignIn, and
      // allowedSegmentIds are server-only policy enforced by evaluateMyPortalAccessFn.
      visibility: portalConfig.access.visibility,
    },
  }
}

/**
 * Strips the server-only access policy fields (allowedDomains, widgetSignIn,
 * allowedSegmentIds) and server-only columns (widgetSecret) from a settings row
 * before returning it to a client-bound context. Keeps access.visibility (it's
 * already public via publicPortalConfig.portalAccess).
 *
 * Accepts either a parsed PortalConfig object or a JSON-string column (raw DB
 * row). When the field is absent or carries no `access` key it is returned
 * untouched. Handles null/undefined gracefully.
 */
export function redactSettingsForClient<T extends { portalConfig?: PortalConfig | string | null }>(
  input: T
): T {
  // Server-only columns (the widget HMAC secret) are dropped unconditionally.
  const row = stripServerOnlyColumns(input)
  const { portalConfig } = row

  if (!portalConfig) return row

  // Parsed object form (TenantSettings.portalConfig)
  if (typeof portalConfig === 'object') {
    if (!portalConfig.access) return row
    // Cast: the shape is identical at runtime; only the access sub-keys differ.
    return { ...row, portalConfig: redactPortalConfig(portalConfig) } as T
  }

  // JSON-string form (raw DB row column)
  if (typeof portalConfig === 'string') {
    try {
      const parsed = JSON.parse(portalConfig) as Partial<PortalConfig>
      if (!parsed.access) return row
      const redacted = redactPortalConfig(parsed as PortalConfig)
      return { ...row, portalConfig: JSON.stringify(redacted) } as T
    } catch {
      // Unparseable — return as-is; the downstream parser handles the error.
      return row
    }
  }

  return row
}

/**
 * Client-bound copy of TenantSettings: the parsed portalConfig keeps only
 * access.visibility, and the raw settings row goes through
 * redactSettingsForClient. Applied both at the bootstrap RPC boundary
 * (getBootstrapData, which is a public `/_serverFn` endpoint) and when the
 * root route places settings into the router context.
 */
export function redactTenantSettingsForClient(
  settings: TenantSettings | null
): TenantSettings | null {
  if (!settings) return settings
  return {
    ...settings,
    // 1. Parsed config on TenantSettings
    portalConfig: settings.portalConfig?.access
      ? {
          ...settings.portalConfig,
          access: {
            // Only expose visibility — keep allowedDomains and widgetSignIn off the wire.
            visibility: settings.portalConfig.access.visibility,
          },
        }
      : settings.portalConfig,
    // 2. Raw DB row — portalConfig column is a JSON string; redact inline.
    settings: settings.settings
      ? redactSettingsForClient(settings.settings as Record<string, unknown>)
      : settings.settings,
  } as TenantSettings
}
