/**
 * Regression: `updateFeatureFlagsFn` shipped with zero auth check —
 * any unauthenticated RPC call could flip `helpCenter` and
 * `aiFeedbackExtraction`. Flipping `helpCenter` exposes a public
 * subdomain; flipping `aiFeedbackExtraction` routes customer feedback
 * through an LLM. Both must be admin-only.
 *
 * This pins the contract at the handler boundary: requireAuth({roles:
 * ['admin']}) is invoked before any write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockUpdateFeatureFlags: vi.fn(),
  mockGetFeatureFlags: vi.fn(),
  mockAssertNotManaged: vi.fn(),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  requireAuth: hoisted.mockRequireAuth,
}))

vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  updateFeatureFlags: hoisted.mockUpdateFeatureFlags,
  getFeatureFlags: hoisted.mockGetFeatureFlags,
}))

vi.mock('@/lib/server/config-file/managed-guard', () => ({
  assertNotManaged: hoisted.mockAssertNotManaged,
}))

type AnyHandler = (args: { data: Record<string, unknown> }) => Promise<unknown>

const handlers: AnyHandler[] = []
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: AnyHandler) {
        handlers.push(fn)
        return chain
      },
    }
    return chain
  },
}))

let updateFeatureFlagsHandler: AnyHandler

beforeEach(async () => {
  vi.clearAllMocks()
  hoisted.mockUpdateFeatureFlags.mockResolvedValue({ aiFeedbackExtraction: true })
  hoisted.mockGetFeatureFlags.mockResolvedValue({ helpCenter: false, aiFeedbackExtraction: false })
  hoisted.mockAssertNotManaged.mockResolvedValue(undefined)
  if (handlers.length === 0) await import('../feature-flags')
  updateFeatureFlagsHandler = handlers[0]
})

describe('updateFeatureFlagsFn — admin gate', () => {
  it('requires admin auth (G12)', async () => {
    hoisted.mockRequireAuth.mockRejectedValueOnce(new Error('Authentication required'))

    await expect(
      updateFeatureFlagsHandler({ data: { aiFeedbackExtraction: true } })
    ).rejects.toThrow(/auth/i)

    expect(hoisted.mockRequireAuth).toHaveBeenCalledWith(
      expect.objectContaining({ roles: expect.arrayContaining(['admin']) })
    )
    expect(hoisted.mockUpdateFeatureFlags).not.toHaveBeenCalled()
  })

  it('refuses a member-role caller', async () => {
    hoisted.mockRequireAuth.mockRejectedValueOnce(new Error('Admin role required'))

    await expect(updateFeatureFlagsHandler({ data: { helpCenter: true } })).rejects.toThrow(/role/i)

    expect(hoisted.mockUpdateFeatureFlags).not.toHaveBeenCalled()
  })

  it('proceeds for an authenticated admin', async () => {
    hoisted.mockRequireAuth.mockResolvedValueOnce({
      user: { id: 'usr_admin' },
      principal: { id: 'prn_admin', role: 'admin' },
    })

    await updateFeatureFlagsHandler({ data: { aiFeedbackExtraction: true } })

    expect(hoisted.mockUpdateFeatureFlags).toHaveBeenCalledWith({ aiFeedbackExtraction: true })
  })
})

describe('updateFeatureFlagsFn — Help Center policy lock', () => {
  const admin = { user: { id: 'usr_admin' }, principal: { id: 'prn_admin', role: 'admin' } }

  it('refuses to turn the Help Center on while policy holds it off', async () => {
    hoisted.mockRequireAuth.mockResolvedValueOnce(admin)
    const { ForbiddenError } = await import('@/lib/shared/errors')
    hoisted.mockAssertNotManaged.mockRejectedValueOnce(
      new ForbiddenError('FIELD_MANAGED', 'managed')
    )

    await expect(updateFeatureFlagsHandler({ data: { helpCenter: true } })).rejects.toMatchObject({
      code: 'FIELD_MANAGED',
    })
    expect(hoisted.mockAssertNotManaged).toHaveBeenCalledWith('features.helpCenter')
    expect(hoisted.mockUpdateFeatureFlags).not.toHaveBeenCalled()
  })

  it('does not consult the lock when the Help Center value is unchanged', async () => {
    hoisted.mockRequireAuth.mockResolvedValueOnce(admin)
    await updateFeatureFlagsHandler({ data: { helpCenter: false, linkPreviews: true } })
    expect(hoisted.mockAssertNotManaged).not.toHaveBeenCalled()
    expect(hoisted.mockUpdateFeatureFlags).toHaveBeenCalled()
  })
})
