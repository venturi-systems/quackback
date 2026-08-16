import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPortalDataQuery = vi.fn((filters: unknown) => ({
  queryKey: ['portal', 'data', filters],
  queryFn: vi.fn(),
}))

vi.mock('@/lib/client/queries/portal', () => ({
  portalQueries: {
    portalData: (filters: unknown) => mockPortalDataQuery(filters),
  },
}))

vi.mock('@/lib/client/hooks/use-portal-posts-query', () => ({
  votedPostsKeys: { byWorkspace: () => ['votedPosts'] },
}))

const { Route: routeOptions } = await import('../_portal/index')

function getLoader() {
  const loader =
    (routeOptions as unknown as { options?: { loader?: unknown } }).options?.loader ??
    (routeOptions as unknown as { loader?: unknown }).loader
  if (typeof loader !== 'function') throw new Error('Could not find portal index loader')
  return loader as (args: { context: unknown; location: { search: unknown } }) => Promise<unknown>
}

function makeContext(principalType: 'anonymous' | 'user') {
  const ensureQueryData = vi.fn().mockResolvedValue({
    boards: [],
    votedPostIds: [],
  })
  const setQueryData = vi.fn()
  return {
    context: {
      session: {
        user: {
          id: principalType === 'anonymous' ? 'anonymous' : 'user_1',
          principalType,
        },
      },
      settings: {
        name: 'Venturi',
        publicPortalConfig: {
          portalAccess: { isPrivate: true },
        },
      },
      queryClient: { ensureQueryData, setQueryData },
      baseUrl: 'https://feedback.venturi.systems',
    },
    ensureQueryData,
    setQueryData,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('_portal index loader — authenticated visibility', () => {
  it('does not fetch or dehydrate portal data for an anonymous visitor', async () => {
    const { context, ensureQueryData, setQueryData } = makeContext('anonymous')

    const result = (await getLoader()({ context, location: { search: {} } })) as {
      accessGated?: boolean
    }

    expect(result.accessGated).toBe(true)
    expect(ensureQueryData).not.toHaveBeenCalled()
    expect(setQueryData).not.toHaveBeenCalled()
    expect(mockPortalDataQuery).not.toHaveBeenCalled()
  })

  it('continues to preload portal data for an authenticated visitor', async () => {
    const { context, ensureQueryData, setQueryData } = makeContext('user')

    const result = (await getLoader()({ context, location: { search: {} } })) as {
      accessGated?: boolean
    }

    expect(result.accessGated).toBe(false)
    expect(ensureQueryData).toHaveBeenCalledOnce()
    expect(setQueryData).toHaveBeenCalledOnce()
  })
})
