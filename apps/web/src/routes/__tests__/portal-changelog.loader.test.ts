import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const publicListOptions = {
    queryKey: ['changelogs', 'public', 'list'],
    queryFn: vi.fn(),
    initialPageParam: undefined,
    getNextPageParam: vi.fn(),
  }

  return {
    publicListOptions,
    publicChangelogList: vi.fn(() => publicListOptions),
  }
})

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => ({ options: opts }),
}))

vi.mock('@/lib/client/queries/changelog', () => ({
  publicChangelogQueries: {
    list: mocks.publicChangelogList,
  },
}))

import { Route } from '../_portal/changelog.index'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoaderFn = (ctx: any) => Promise<{
  workspaceName: string
  baseUrl: string
}>
const loader = (Route as unknown as { options: { loader: LoaderFn } }).options.loader

beforeEach(() => {
  vi.clearAllMocks()
})

describe('portal changelog route loader', () => {
  it('prefetches the public changelog list for SSR and no-JS rendering', async () => {
    const ensureInfiniteQueryData = vi.fn().mockResolvedValue({ pages: [{ items: [] }] })

    const result = await loader({
      context: {
        queryClient: { ensureInfiniteQueryData },
        settings: { name: 'Venturi' },
        baseUrl: 'https://feedback.venturi.systems',
      },
    })

    expect(mocks.publicChangelogList).toHaveBeenCalledOnce()
    expect(ensureInfiniteQueryData).toHaveBeenCalledWith(mocks.publicListOptions)
    expect(result).toEqual({
      workspaceName: 'Venturi',
      baseUrl: 'https://feedback.venturi.systems',
    })
  })
})
