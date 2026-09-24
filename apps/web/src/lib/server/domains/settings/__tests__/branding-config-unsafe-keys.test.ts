/**
 * DEF-54: brandingConfig must never store or return `__proto__`,
 * `constructor` or `prototype` keys, at any depth.
 *
 * updateThemeFn validates brandingConfig only as
 * `z.record(z.string(), z.unknown())`, and the column is read back whole
 * instead of through parseJsonConfig / deepMerge. Payloads and stored rows go
 * through JSON.parse on purpose: an object literal `{ __proto__: {...} }` SETS
 * the literal's prototype, while JSON.parse makes `__proto__` an ordinary own
 * key, which is what a request body or a stored column actually contains.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrandingConfig } from '../settings.types'

// --- Redis cache mocks ---
const mockCacheGet = vi.fn()
const mockCacheSet = vi.fn()
const mockCacheDel = vi.fn()

vi.mock('@/lib/server/redis', () => ({
  cacheGet: (...args: unknown[]) => mockCacheGet(...args),
  cacheSet: (...args: unknown[]) => mockCacheSet(...args),
  cacheDel: (...args: unknown[]) => mockCacheDel(...args),
  CACHE_KEYS: {
    TENANT_SETTINGS: 'settings:tenant',
    INTEGRATION_MAPPINGS: 'hooks:integration-mappings',
    ACTIVE_WEBHOOKS: 'hooks:webhooks-active',
    SLACK_CHANNELS: 'slack:channels',
  },
}))

// --- DB mock ---
const mockFindFirst = vi.fn()
const mockUpdate = vi.fn()
const mockSet = vi.fn()
const mockWhere = vi.fn()

type SettingsTx = {
  query: { settings: { findFirst: (...args: unknown[]) => unknown } }
  update: (...args: unknown[]) => unknown
}

vi.mock('@/lib/server/db', () => {
  const tx: SettingsTx = {
    query: { settings: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    update: (...args: unknown[]) => mockUpdate(...args),
  }
  return {
    db: {
      query: {
        settings: {
          findFirst: (...args: unknown[]) => mockFindFirst(...args),
        },
      },
      update: (...args: unknown[]) => mockUpdate(...args),
      select: () => ({
        from: () => ({
          limit: () => Promise.resolve([]),
          orderBy: () => Promise.resolve([]),
        }),
      }),
      transaction: async (fn: (tx: SettingsTx) => unknown) => fn(tx),
    },
    eq: vi.fn(),
    settings: { id: 'id', tierLimits: 'tier_limits', authConfigVersion: 'auth_config_version' },
    ssoVerifiedDomain: { id: 'id', createdAt: 'created_at' },
    identityProvider: { id: 'id', createdAt: 'created_at' },
  }
})

vi.mock('@/lib/server/auth/config-version', () => ({
  bumpAuthConfigVersionInTx: vi.fn(),
}))

vi.mock('@/lib/server/auth', () => ({
  resetAuth: vi.fn(),
}))

vi.mock('@/lib/server/storage/s3', () => ({
  getPublicUrlOrNull: (key: string | null) => (key ? `https://cdn.test/${key}` : null),
  deleteObject: vi.fn(),
}))

vi.mock('@/lib/server/domains/platform-credentials/platform-credential.service', () => ({
  getConfiguredIntegrationTypes: vi.fn().mockResolvedValue(new Set()),
  getPlatformCredentials: vi.fn().mockResolvedValue(null),
}))

vi.mock('@quackback/email', () => ({
  isEmailConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('@/lib/server/auth/auth-providers', () => ({
  getAllAuthProviders: vi.fn().mockReturnValue([]),
}))

// The custom-colours tier gate is not under test here; let every save through
// and record that it was still consulted.
const mockAssertTierFeature = vi.fn()
vi.mock('../tier-enforce', () => ({
  assertTierFeature: (...args: unknown[]) => mockAssertTierFeature(...args),
}))

function makeSettingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings_1',
    name: 'Test Workspace',
    slug: 'test',
    authConfig: null,
    portalConfig: null,
    brandingConfig: null,
    developerConfig: null,
    widgetConfig: null,
    customCss: null,
    logoKey: null,
    faviconKey: null,
    headerLogoKey: null,
    headerDisplayMode: 'logo_and_name',
    headerDisplayName: null,
    widgetSecret: null,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  }
}

// Import after mocks
const { getTenantSettings } = await import('../settings.service')
const { getBrandingConfig, updateBrandingConfig } = await import('../settings.media')
const { parseJsonOrNull, withoutUnsafeKeys } = await import('../settings.helpers')

const PROBE = 'def54Polluted'
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype']

function objectPrototypeIsClean(): boolean {
  return !Object.prototype.hasOwnProperty.call(Object.prototype, PROBE) && !(PROBE in {})
}

/** Paths of every own `__proto__`, `constructor` or `prototype` key, at any depth. */
function unsafeKeyPaths(value: unknown, path = '$'): string[] {
  if (typeof value !== 'object' || value === null) return []
  const found: string[] = []
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.includes(key)) found.push(`${path}.${key}`)
    found.push(...unsafeKeyPaths((value as Record<string, unknown>)[key], `${path}.${key}`))
  }
  return found
}

/** The JSON string updateBrandingConfig handed to `db.update(settings).set()`. */
function storedBrandingJson(): string {
  expect(mockSet).toHaveBeenCalledTimes(1)
  const [values] = mockSet.mock.calls[0] as [{ brandingConfig: string }]
  return values.brandingConfig
}

// A branding config shaped like the one the admin theme editor saves
// (use-branding-state.ts): themeMode plus light and dark variable sets that
// carry the font stack and radius.
const ORDINARY_BRANDING: Record<string, unknown> = {
  themeMode: 'user',
  light: {
    background: 'oklch(1 0 0)',
    foreground: 'oklch(0.145 0 0)',
    primary: 'oklch(0.205 0.064 285.885)',
    primaryForeground: 'oklch(0.985 0 0)',
    border: 'oklch(0.922 0 0)',
    fontSans: '"Inter", ui-sans-serif, system-ui, sans-serif',
    radius: '0.625rem',
  },
  dark: {
    background: 'oklch(0.145 0 0)',
    foreground: 'oklch(0.985 0 0)',
    primary: '#6d28d9',
    primaryForeground: '#ffffff',
    border: 'rgba(255, 255, 255, 0.1)',
    fontSans: '"Inter", ui-sans-serif, system-ui, sans-serif',
    radius: '0.625rem',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCacheGet.mockResolvedValue(null)
  mockCacheSet.mockResolvedValue(undefined)
  mockCacheDel.mockResolvedValue(undefined)
  mockAssertTierFeature.mockResolvedValue(undefined)
  // Chain: db.update().set().where()
  mockWhere.mockResolvedValue(undefined)
  mockSet.mockReturnValue({ where: mockWhere })
  mockUpdate.mockReturnValue({ set: mockSet })
  mockFindFirst.mockResolvedValue(makeSettingsRow())
})

afterEach(() => {
  // If a guard ever regresses, keep the damage out of every later test.
  delete (Object.prototype as Record<string, unknown>)[PROBE]
})

describe('updateBrandingConfig unsafe-key guard', () => {
  it('drops __proto__, constructor and prototype at every depth before storing', async () => {
    const payload = JSON.parse(
      `{"themeMode":"dark","constructor":{"prototype":{"${PROBE}":true}},"prototype":{"${PROBE}":true},` +
        `"light":{"primary":"#123456","__proto__":{"${PROBE}":true},"constructor":{"prototype":{"${PROBE}":true}}},` +
        `"dark":{"primary":"#654321","prototype":{"${PROBE}":true},"nested":{"__proto__":{"${PROBE}":true},"kept":1}}}`
    )
    // The premise: every one of these reaches updateBrandingConfig as an own key.
    expect(unsafeKeyPaths(payload)).toEqual([
      '$.constructor',
      '$.constructor.prototype',
      '$.prototype',
      '$.light.__proto__',
      '$.light.constructor',
      '$.light.constructor.prototype',
      '$.dark.prototype',
      '$.dark.nested.__proto__',
    ])

    const returned = await updateBrandingConfig(payload as BrandingConfig)

    const stored = storedBrandingJson()
    expect(stored).toBe(
      '{"themeMode":"dark","light":{"primary":"#123456"},"dark":{"primary":"#654321","nested":{"kept":1}}}'
    )
    expect(stored).not.toContain(PROBE)
    expect(unsafeKeyPaths(JSON.parse(stored))).toEqual([])

    expect(returned).toEqual(JSON.parse(stored))
    expect(unsafeKeyPaths(returned)).toEqual([])
    expect(Object.getPrototypeOf(returned)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(returned.light)).toBe(Object.prototype)
    expect(PROBE in (returned.light as object)).toBe(false)
    expect(objectPrototypeIsClean()).toBe(true)

    // The custom-colours gate still sees the light/dark overrides.
    expect(mockAssertTierFeature).toHaveBeenCalledWith('customColors', 'Custom colours')
  })

  it('drops unsafe keys from objects inside arrays', async () => {
    const payload = JSON.parse(
      `{"preset":"custom","list":[{"__proto__":{"${PROBE}":true},"k":1},[{"constructor":{"prototype":{"${PROBE}":true}},"j":2}],"text",3,null]}`
    )

    await updateBrandingConfig(payload as BrandingConfig)

    expect(storedBrandingJson()).toBe(
      '{"preset":"custom","list":[{"k":1},[{"j":2}],"text",3,null]}'
    )
    expect(objectPrototypeIsClean()).toBe(true)
  })
})

describe('branding config read guard for stored rows', () => {
  const STORED =
    `{"__proto__":{"${PROBE}":true},"themeMode":"light",` +
    `"light":{"primary":"#123456","__proto__":{"${PROBE}":true},"constructor":{"prototype":{"${PROBE}":true}}},` +
    `"dark":{"prototype":{"${PROBE}":true},"primary":"#654321"},` +
    `"extra":[{"__proto__":{"${PROBE}":true},"k":1}]}`
  const CLEAN = {
    themeMode: 'light',
    light: { primary: '#123456' },
    dark: { primary: '#654321' },
    extra: [{ k: 1 }],
  }

  it('the stored row really carries the unsafe keys', () => {
    expect(unsafeKeyPaths(JSON.parse(STORED))).toEqual([
      '$.__proto__',
      '$.light.__proto__',
      '$.light.constructor',
      '$.light.constructor.prototype',
      '$.dark.prototype',
      '$.extra.0.__proto__',
    ])
  })

  it('getBrandingConfig returns the stored row without them', async () => {
    mockFindFirst.mockResolvedValue(makeSettingsRow({ brandingConfig: STORED }))

    const config = await getBrandingConfig()

    expect(unsafeKeyPaths(config)).toEqual([])
    expect(config).toEqual(CLEAN)
    expect(JSON.stringify(config)).toBe(JSON.stringify(CLEAN))
    expect(Object.getPrototypeOf(config)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(config.light)).toBe(Object.prototype)
    expect(objectPrototypeIsClean()).toBe(true)
  })

  it('getTenantSettings returns and caches the parsed config without them', async () => {
    mockFindFirst.mockResolvedValue(makeSettingsRow({ brandingConfig: STORED }))

    // Only the parsed `brandingConfig` is checked. TenantSettings also carries
    // the raw row as `settings`, where every JSON column stays the unparsed
    // text it was stored as; nothing parses the raw branding text.
    const result = await getTenantSettings()

    expect(result?.brandingConfig).toEqual(CLEAN)
    expect(unsafeKeyPaths(result?.brandingConfig)).toEqual([])
    const [, cached] = mockCacheSet.mock.calls[0] as [string, { brandingConfig: unknown }]
    expect(unsafeKeyPaths(cached.brandingConfig)).toEqual([])
    expect(JSON.stringify(cached.brandingConfig)).not.toContain(PROBE)
    expect(objectPrototypeIsClean()).toBe(true)
  })

  it('still reads an empty, null or unparseable column as an empty config', async () => {
    for (const brandingConfig of [null, '', 'null', '{not json']) {
      mockFindFirst.mockResolvedValue(makeSettingsRow({ brandingConfig }))
      await expect(getBrandingConfig()).resolves.toEqual({})
    }
  })
})

describe('ordinary branding values round-trip unchanged', () => {
  it('stores exactly what JSON.stringify of the input produces and returns it', async () => {
    const input = JSON.parse(JSON.stringify(ORDINARY_BRANDING)) as BrandingConfig

    const returned = await updateBrandingConfig(input)

    const stored = storedBrandingJson()
    expect(stored).toBe(JSON.stringify(ORDINARY_BRANDING))
    expect(returned).toEqual(ORDINARY_BRANDING)
    // The caller's object is not mutated.
    expect(input).toEqual(ORDINARY_BRANDING)
  })

  it('reads the stored row back deep-equal and JSON-identical', async () => {
    mockFindFirst.mockResolvedValue(
      makeSettingsRow({ brandingConfig: JSON.stringify(ORDINARY_BRANDING) })
    )

    const config = await getBrandingConfig()
    expect(config).toEqual(ORDINARY_BRANDING)
    expect(JSON.stringify(config)).toBe(JSON.stringify(ORDINARY_BRANDING))

    const tenant = await getTenantSettings()
    expect(tenant?.brandingConfig).toEqual(ORDINARY_BRANDING)
    expect(JSON.stringify(tenant?.brandingConfig)).toBe(JSON.stringify(ORDINARY_BRANDING))
  })

  it('keeps a preset and themeMode save as sent', async () => {
    await updateBrandingConfig({ preset: 'custom', themeMode: 'dark' })
    expect(storedBrandingJson()).toBe('{"preset":"custom","themeMode":"dark"}')
    // No light/dark overrides, so the custom-colours gate is not consulted.
    expect(mockAssertTierFeature).not.toHaveBeenCalled()
  })
})

describe('withoutUnsafeKeys', () => {
  it('returns primitives and null as given', () => {
    for (const value of ['text', 3, true, null, undefined]) {
      expect(withoutUnsafeKeys(value)).toBe(value)
    }
  })

  it('copies instead of returning the same object', () => {
    const value = { a: { b: [{ c: 1 }] } }

    const copy = withoutUnsafeKeys(value) as typeof value

    expect(copy).toEqual(value)
    expect(copy).not.toBe(value)
    expect(copy.a).not.toBe(value.a)
    expect(copy.a.b).not.toBe(value.a.b)
  })

  it('cleans a top-level array', () => {
    const value = JSON.parse(`[{"__proto__":{"${PROBE}":true},"k":1},"x"]`)

    expect(JSON.stringify(withoutUnsafeKeys(value))).toBe('[{"k":1},"x"]')
    expect(objectPrototypeIsClean()).toBe(true)
  })

  it('backs parseJsonOrNull', () => {
    const parsed = parseJsonOrNull<Record<string, unknown>>(
      `{"a":{"constructor":{"prototype":{"${PROBE}":true}},"b":2}}`
    )

    expect(JSON.stringify(parsed)).toBe('{"a":{"b":2}}')
    expect(parseJsonOrNull('null')).toBeNull()
    expect(parseJsonOrNull('{not json')).toBeNull()
    expect(parseJsonOrNull(null)).toBeNull()
  })
})
