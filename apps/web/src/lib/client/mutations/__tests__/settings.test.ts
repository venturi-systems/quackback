import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.hoisted so the vi.mock factory below can reference it during the
// hoisted static-import phase; the hooks under test then load statically
// during file collection instead of inside a test body's timeout budget.
const { invalidateQueries } = vi.hoisted(() => ({ invalidateQueries: vi.fn() }))

vi.mock('@tanstack/react-query', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query')
  return {
    ...actual,
    useMutation: vi.fn((options: unknown) => options),
    useQueryClient: vi.fn(() => ({ invalidateQueries })),
  }
})

import {
  useUpdatePortalConfig,
  useUpdateModerationDefault,
  useUpdateWidgetConfig,
  useRegenerateWidgetSecret,
  useUpdateHelpCenterConfig,
  useSaveBrandingTheme,
} from '../settings'

describe('settings config mutations cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // invalidateQueries returns a promise; onSuccess must return it so the
    // mutation stays pending until the refetch settles (otherwise a fast
    // navigate-away/back can re-read the still-stale cache via ensureQueryData).
    invalidateQueries.mockResolvedValue(undefined)
  })

  it('useUpdatePortalConfig.onSuccess awaits invalidation of the portalConfig query', async () => {
    const mutation = useUpdatePortalConfig() as { onSuccess?: () => unknown }

    const result = mutation.onSuccess?.()

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settings', 'portalConfig'] })
    expect(result).toBeInstanceOf(Promise)
  })

  it('useUpdateModerationDefault.onSuccess awaits invalidation of the portalConfig query', async () => {
    const mutation = useUpdateModerationDefault() as { onSuccess?: () => unknown }

    const result = mutation.onSuccess?.()

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settings', 'portalConfig'] })
    expect(result).toBeInstanceOf(Promise)
  })

  it('useUpdateWidgetConfig.onSuccess awaits invalidation of the widgetConfig query', async () => {
    const mutation = useUpdateWidgetConfig() as { onSuccess?: () => unknown }

    const result = mutation.onSuccess?.()

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settings', 'widgetConfig'] })
    expect(result).toBeInstanceOf(Promise)
  })

  it('useRegenerateWidgetSecret.onSuccess awaits invalidation of the widgetSecret query', async () => {
    const mutation = useRegenerateWidgetSecret() as { onSuccess?: () => unknown }

    const result = mutation.onSuccess?.()

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settings', 'widgetSecret'] })
    expect(result).toBeInstanceOf(Promise)
  })

  it('useUpdateHelpCenterConfig.onSuccess awaits invalidation of the helpCenterConfig query', async () => {
    const mutation = useUpdateHelpCenterConfig() as { onSuccess?: () => unknown }

    const result = mutation.onSuccess?.()

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settings', 'helpCenterConfig'] })
    expect(result).toBeInstanceOf(Promise)
  })

  it('useSaveBrandingTheme.onSuccess awaits invalidation of branding and customCss queries', async () => {
    const mutation = useSaveBrandingTheme() as { onSuccess?: () => unknown }

    const result = mutation.onSuccess?.()

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settings', 'branding'] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['settings', 'customCss'] })
    expect(result).toBeInstanceOf(Promise)
  })
})
