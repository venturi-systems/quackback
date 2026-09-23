/**
 * Unit tests for redactSettingsForClient.
 *
 * Pure function — no DB, no mocks needed.
 */
import { describe, it, expect } from 'vitest'
import { redactSettingsForClient, redactTenantSettingsForClient } from '../redact-portal-config'
import type { PortalConfig } from '@/lib/server/domains/settings/settings.types'

const ACCESS_POLICY = {
  visibility: 'private' as const,
  allowedDomains: ['acme.example', 'beta.example'],
  widgetSignIn: true,
  allowedSegmentIds: [],
}

const FULL_PORTAL_CONFIG: PortalConfig = {
  features: {
    allowAnonymous: true,
    allowEditAfterEngagement: false,
    allowDeleteAfterEngagement: false,
    showPublicEditHistory: false,
  },
  moderationDefault: { requireApproval: 'none' },
  access: ACCESS_POLICY,
}

describe('redactSettingsForClient — parsed object portalConfig', () => {
  it('strips allowedDomains and widgetSignIn, keeps visibility', () => {
    const row = { portalConfig: FULL_PORTAL_CONFIG, name: 'Acme' }
    const result = redactSettingsForClient(row)

    expect(result.portalConfig.access).toEqual({ visibility: 'private' })
    expect(result.portalConfig.access).not.toHaveProperty('allowedDomains')
    expect(result.portalConfig.access).not.toHaveProperty('widgetSignIn')
  })

  it('leaves features and moderationDefault intact', () => {
    const row = { portalConfig: FULL_PORTAL_CONFIG, name: 'Acme' }
    const result = redactSettingsForClient(row)

    expect(result.portalConfig.features).toEqual(FULL_PORTAL_CONFIG.features)
    expect(result.portalConfig.moderationDefault).toEqual(FULL_PORTAL_CONFIG.moderationDefault)
  })

  it('passes through a config with no access key unchanged', () => {
    const noAccess = { ...FULL_PORTAL_CONFIG, access: undefined }
    const row = { portalConfig: noAccess, name: 'Acme' }
    const result = redactSettingsForClient(row)

    expect(result).toBe(row) // same reference — no copy made
  })

  it('passes through null portalConfig unchanged', () => {
    const row = { portalConfig: null, name: 'Acme' }
    const result = redactSettingsForClient(row)

    expect(result).toBe(row)
  })

  it('passes through missing portalConfig unchanged', () => {
    const row = { name: 'Acme' } as { name: string; portalConfig?: PortalConfig | null }
    const result = redactSettingsForClient(row)

    expect(result).toBe(row)
  })
})

describe('redactSettingsForClient — JSON-string portalConfig (raw DB row)', () => {
  it('strips allowedDomains and widgetSignIn from the JSON string', () => {
    const row = {
      name: 'Acme',
      portalConfig: JSON.stringify(FULL_PORTAL_CONFIG),
    }
    const result = redactSettingsForClient(row)

    const parsed = JSON.parse(result.portalConfig as string) as PortalConfig
    expect(parsed.access).toEqual({ visibility: 'private' })
    expect(parsed.access).not.toHaveProperty('allowedDomains')
    expect(parsed.access).not.toHaveProperty('widgetSignIn')
  })

  it('leaves the rest of the JSON string intact when redacting', () => {
    const row = {
      name: 'Acme',
      portalConfig: JSON.stringify(FULL_PORTAL_CONFIG),
    }
    const result = redactSettingsForClient(row)

    const parsed = JSON.parse(result.portalConfig as string) as PortalConfig
    expect(parsed.features).toEqual(FULL_PORTAL_CONFIG.features)
    expect(parsed.moderationDefault).toEqual(FULL_PORTAL_CONFIG.moderationDefault)
  })

  it('passes through a JSON string with no access key unchanged', () => {
    const noAccess = { features: FULL_PORTAL_CONFIG.features }
    const row = { name: 'Acme', portalConfig: JSON.stringify(noAccess) }
    const result = redactSettingsForClient(row)

    expect(result).toBe(row)
  })

  it('passes through unparseable JSON strings unchanged', () => {
    const row = { name: 'Acme', portalConfig: 'not valid json' }
    const result = redactSettingsForClient(row)

    expect(result).toBe(row)
  })
})

describe('redactSettingsForClient — allowedSegmentIds redaction', () => {
  it('strips access.allowedSegmentIds from the parsed PortalConfig', () => {
    const row = {
      portalConfig: {
        features: FULL_PORTAL_CONFIG.features,
        moderationDefault: { requireApproval: 'none' as const },
        access: {
          visibility: 'private' as const,
          allowedDomains: ['acme.com'],
          widgetSignIn: false,
          allowedSegmentIds: ['seg_1', 'seg_2'],
        },
      },
    }
    const redacted = redactSettingsForClient(row)
    expect(redacted.portalConfig.access).not.toHaveProperty('allowedSegmentIds')
    expect(redacted.portalConfig.access).toEqual({ visibility: 'private' })
  })

  it('strips access.allowedSegmentIds from the raw JSON-string portalConfig', () => {
    const row = {
      portalConfig: JSON.stringify({
        access: {
          visibility: 'private',
          allowedDomains: ['acme.com'],
          widgetSignIn: false,
          allowedSegmentIds: ['seg_1'],
        },
      }),
    }
    const redacted = redactSettingsForClient(row)
    expect(redacted.portalConfig).not.toContain('allowedSegmentIds')
    expect(redacted.portalConfig).not.toContain('seg_1')
  })
})

describe('redactSettingsForClient — SSR payload invariants', () => {
  it('the SSR payload string does not contain allowedDomains after redaction (object form)', () => {
    const row = { portalConfig: FULL_PORTAL_CONFIG, name: 'Acme' }
    const result = redactSettingsForClient(row)
    const payload = JSON.stringify(result)

    expect(payload).not.toContain('allowedDomains')
    expect(payload).not.toContain('acme.example')
    expect(payload).not.toContain('widgetSignIn')
  })

  it('the SSR payload string does not contain allowedDomains after redaction (string form)', () => {
    const row = { name: 'Acme', portalConfig: JSON.stringify(FULL_PORTAL_CONFIG) }
    const result = redactSettingsForClient(row)
    const payload = JSON.stringify(result)

    expect(payload).not.toContain('allowedDomains')
    expect(payload).not.toContain('acme.example')
    expect(payload).not.toContain('widgetSignIn')
  })
})

describe('redactSettingsForClient — server-only columns', () => {
  it('drops widgetSecret even when portalConfig is absent', () => {
    const row = { name: 'Acme', widgetSecret: 'wgt_secret', portalConfig: null }
    const result = redactSettingsForClient(row)
    expect(result).not.toHaveProperty('widgetSecret')
    expect(result.name).toBe('Acme')
  })

  it('drops widgetSecret alongside the access-policy redaction', () => {
    const row = {
      name: 'Acme',
      widgetSecret: 'wgt_secret',
      portalConfig: JSON.stringify(FULL_PORTAL_CONFIG),
    }
    const result = redactSettingsForClient(row)
    expect(result).not.toHaveProperty('widgetSecret')
    expect(JSON.parse(result.portalConfig as string).access).toEqual({ visibility: 'private' })
  })

  it('does not mutate the input row', () => {
    const row = { name: 'Acme', widgetSecret: 'wgt_secret', portalConfig: null }
    redactSettingsForClient(row)
    expect(row.widgetSecret).toBe('wgt_secret')
  })
})

describe('redactTenantSettingsForClient', () => {
  it('returns null unchanged', () => {
    expect(redactTenantSettingsForClient(null)).toBeNull()
  })

  it('redacts the parsed portalConfig and the raw row, including widgetSecret', () => {
    const tenant = {
      name: 'Acme',
      portalConfig: FULL_PORTAL_CONFIG,
      settings: {
        name: 'Acme',
        widgetSecret: 'wgt_secret',
        portalConfig: JSON.stringify(FULL_PORTAL_CONFIG),
      },
    } as unknown as Parameters<typeof redactTenantSettingsForClient>[0]
    const result = redactTenantSettingsForClient(tenant)!
    expect(result.portalConfig.access).toEqual({ visibility: 'private' })
    expect(result.settings).not.toHaveProperty('widgetSecret')
    expect(JSON.parse(result.settings.portalConfig as string).access).toEqual({
      visibility: 'private',
    })
    expect(JSON.stringify(result)).not.toContain('acme.example')
    expect(JSON.stringify(result)).not.toContain('wgt_secret')
  })
})
