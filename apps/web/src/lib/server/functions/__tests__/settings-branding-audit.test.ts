/**
 * REQ-15 (landing-page#2309): the logo, header logo and header display
 * mutations write one `settings.changed` audit row each, with the value
 * before and after the change. They were the admin settings mutations the
 * audit coverage left out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type AnyHandler = (args: { data?: Record<string, unknown> }) => Promise<unknown>

vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain: { validator: () => typeof chain; handler: (fn: AnyHandler) => typeof chain } & {
      run?: AnyHandler
    } = {
      validator() {
        return chain
      },
      handler(fn: AnyHandler) {
        chain.run = fn
        return chain
      },
    }
    return chain
  },
}))

const hoisted = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  recordAuditSafely: vi.fn(),
  requireSettings: vi.fn(),
  saveLogoKey: vi.fn(),
  deleteLogoKey: vi.fn(),
  saveHeaderLogoKey: vi.fn(),
  deleteHeaderLogoKey: vi.fn(),
  updateHeaderDisplayMode: vi.fn(),
  updateHeaderDisplayName: vi.fn(),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({ requireAuth: hoisted.requireAuth }))

vi.mock('@/lib/server/audit/audit-safe', () => ({
  recordAuditSafely: hoisted.recordAuditSafely,
  sessionAuditActor: (auth: { user?: { id?: string } }) => ({ userId: auth?.user?.id ?? null }),
}))

vi.mock('@/lib/server/domains/settings/settings.helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/domains/settings/settings.helpers')>()),
  requireSettings: hoisted.requireSettings,
}))

vi.mock('@/lib/server/domains/settings/settings.media', () => ({
  getBrandingConfig: vi.fn(),
  updateBrandingConfig: vi.fn(),
  saveLogoKey: hoisted.saveLogoKey,
  deleteLogoKey: hoisted.deleteLogoKey,
  saveHeaderLogoKey: hoisted.saveHeaderLogoKey,
  deleteHeaderLogoKey: hoisted.deleteHeaderLogoKey,
  updateHeaderDisplayMode: hoisted.updateHeaderDisplayMode,
  updateHeaderDisplayName: hoisted.updateHeaderDisplayName,
  updateWorkspaceName: vi.fn(),
  getCustomCss: vi.fn(),
  updateCustomCss: vi.fn(),
}))

vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getPortalConfig: vi.fn(),
  getPublicPortalConfig: vi.fn(),
  getPublicAuthConfig: vi.fn(),
  updatePortalConfig: vi.fn(),
  getDeveloperConfig: vi.fn(),
  updateDeveloperConfig: vi.fn(),
  getTenantSettings: vi.fn(),
}))

const settingsModule = await import('../settings')

function run(fn: unknown, data?: Record<string, unknown>): Promise<unknown> {
  const handler = (fn as { run?: AnyHandler }).run
  if (!handler) throw new Error('server function handler was not captured')
  return handler({ data })
}

/** The settings.changed rows written during the call. */
function auditRows() {
  return hoisted.recordAuditSafely.mock.calls
    .map(([input]) => input as Record<string, unknown>)
    .filter((input) => input.event === 'settings.changed')
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireAuth.mockResolvedValue({
    user: { id: 'user_admin1', email: 'admin@example.com' },
    principal: { id: 'principal_admin1', role: 'admin', type: 'user' },
  })
  hoisted.requireSettings.mockResolvedValue({
    id: 'workspace_1',
    logoKey: 'logos/old.png',
    headerLogoKey: 'header-logos/old.png',
    headerDisplayMode: 'logo_and_name',
    headerDisplayName: 'Old name',
  })
  hoisted.saveLogoKey.mockImplementation(async (key: string) => ({ success: true, key }))
  hoisted.deleteLogoKey.mockResolvedValue({ success: true })
  hoisted.saveHeaderLogoKey.mockImplementation(async (key: string) => ({ success: true, key }))
  hoisted.deleteHeaderLogoKey.mockResolvedValue({ success: true })
  hoisted.updateHeaderDisplayMode.mockImplementation(async (mode: string) => mode)
  hoisted.updateHeaderDisplayName.mockImplementation(async (name: string | null) => name)
})

describe('branding settings mutations write one settings.changed row each (REQ-15)', () => {
  it.each([
    {
      name: 'saveLogoKeyFn',
      data: { key: 'logos/new.png' },
      section: 'branding.logo',
      before: { logoKey: 'logos/old.png' },
      after: { logoKey: 'logos/new.png' },
    },
    {
      name: 'deleteLogoFn',
      data: undefined,
      section: 'branding.logo',
      before: { logoKey: 'logos/old.png' },
      after: { logoKey: null },
    },
    {
      name: 'saveHeaderLogoKeyFn',
      data: { key: 'header-logos/new.png' },
      section: 'branding.header_logo',
      before: { headerLogoKey: 'header-logos/old.png' },
      after: { headerLogoKey: 'header-logos/new.png' },
    },
    {
      name: 'deleteHeaderLogoFn',
      data: undefined,
      section: 'branding.header_logo',
      before: { headerLogoKey: 'header-logos/old.png' },
      after: { headerLogoKey: null },
    },
    {
      name: 'updateHeaderDisplayModeFn',
      data: { mode: 'logo_only' },
      section: 'branding.header_display_mode',
      before: { headerDisplayMode: 'logo_and_name' },
      after: { headerDisplayMode: 'logo_only' },
    },
    {
      name: 'updateHeaderDisplayNameFn',
      data: { name: 'New name' },
      section: 'branding.header_display_name',
      before: { headerDisplayName: 'Old name' },
      after: { headerDisplayName: 'New name' },
    },
  ])(
    '$name records $section with before and after',
    async ({ name, data, section, before, after }) => {
      await run(settingsModule[name as keyof typeof settingsModule], data)
      const rows = auditRows()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        event: 'settings.changed',
        actor: { userId: 'user_admin1' },
        target: { type: 'settings', id: section },
        before,
        after,
        metadata: { section },
      })
    }
  )

  it('records no row when the change itself fails', async () => {
    hoisted.saveLogoKey.mockRejectedValue(new Error('storage down'))
    await expect(run(settingsModule.saveLogoKeyFn, { key: 'logos/new.png' })).rejects.toThrow(
      'storage down'
    )
    expect(auditRows()).toEqual([])
  })

  it('still records the change when the before-value cannot be read', async () => {
    hoisted.requireSettings.mockRejectedValue(new Error('read failed'))
    await run(settingsModule.updateHeaderDisplayModeFn, { mode: 'logo_only' })
    expect(auditRows()).toEqual([
      expect.objectContaining({ before: null, after: { headerDisplayMode: 'logo_only' } }),
    ])
  })

  it('checks the administrator role before reading or changing anything', async () => {
    hoisted.requireAuth.mockRejectedValue(new Error('Access denied'))
    await expect(run(settingsModule.deleteHeaderLogoFn)).rejects.toThrow('Access denied')
    expect(hoisted.deleteHeaderLogoKey).not.toHaveBeenCalled()
    expect(auditRows()).toEqual([])
  })
})
