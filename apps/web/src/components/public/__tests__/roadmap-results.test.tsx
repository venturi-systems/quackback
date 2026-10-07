// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import type { RoadmapId, StatusId } from '@quackback/ids'
import type { RoadmapFilters } from '@/lib/shared/types'

const { query, navigate, routeSearch, renderedRouter, liveRouter, router } = vi.hoisted(() => {
  // The router state a render subscribes to, and the state the router holds
  // when an effect reads it. They differ when a navigation starts in between.
  const renderedRouter = vi.fn()
  const liveRouter = vi.fn()
  return {
    query: vi.fn(),
    navigate: vi.fn(),
    routeSearch: vi.fn(),
    renderedRouter,
    liveRouter,
    router: {
      get state() {
        return liveRouter()
      },
    },
  }
})
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => router,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) => select(renderedRouter()),
}))
vi.mock('@/routes/_portal/roadmap.index', () => ({
  Route: { useSearch: () => routeSearch() },
}))
vi.mock('@/lib/client/hooks/use-roadmap-posts-query', () => ({
  usePublicRoadmapPosts: query,
  flattenRoadmapPostEntries: (data: { pages: Array<{ items: unknown[] }> } | undefined) =>
    data?.pages.flatMap((page) => page.items) ?? [],
}))
vi.mock('@/lib/client/hooks/use-infinite-scroll', () => ({
  useInfiniteScroll: () => ({ current: null }),
}))
vi.mock('../roadmap-card', () => ({
  RoadmapCard: ({ title }: { title: string }) => <div>{title}</div>,
}))

import { RoadmapColumn } from '../roadmap-column'
import { usePublicRoadmapSelection } from '../use-public-roadmap-selection'

function column(filters?: RoadmapFilters, signInRequiredForItems = false) {
  return (
    <IntlProvider locale="en" defaultLocale="en">
      <RoadmapColumn
        roadmapId={'roadmap_test' as RoadmapId}
        statusId={'status_test' as StatusId}
        title="Planned"
        color="#2563eb"
        filters={filters}
        signInRequiredForItems={signInRequiredForItems}
      />
    </IntlProvider>
  )
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [{ items: [], total: 0, hasMore: false }] },
    isLoading: false,
    isPending: false,
    isFetching: false,
    isFetchingNextPage: false,
    isPlaceholderData: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    ...overrides,
  }
}

/** Router state headed for `href`, resolved at `resolvedHref` (idle when equal). */
function routerAt(href: string, resolvedHref: string | undefined = href) {
  const at = (target: string) => ({ href: target, pathname: target.split('?')[0] })
  return {
    status: href === resolvedHref ? 'idle' : 'pending',
    location: at(href),
    resolvedLocation: resolvedHref === undefined ? undefined : at(resolvedHref),
  }
}

function routerIs(state: ReturnType<typeof routerAt>) {
  renderedRouter.mockReturnValue(state)
  liveRouter.mockReturnValue(state)
}

beforeEach(() => {
  query.mockReturnValue(result())
  navigate.mockClear()
  routeSearch.mockReturnValue({})
  routerIs(routerAt('/roadmap'))
})

describe('Roadmap result states', () => {
  it('distinguishes an empty column from a filtered no-match', () => {
    const { rerender } = render(column({ sort: 'oldest' }))
    expect(screen.getByText('No items yet')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('Planned: 0')
    rerender(column({ search: 'missing' }))
    expect(screen.getByText('No posts match your filters.')).toBeVisible()
    expect(screen.queryByText('No items yet')).not.toBeInTheDocument()
  })

  it.each([{ board: ['board_test'] }, { tags: ['tag_test'] }, { segmentIds: ['segment_test'] }])(
    'recognizes facet-only no-match states: %j',
    (filters) => {
      render(column(filters))
      expect(screen.getByText('No posts match your filters.')).toBeVisible()
    }
  )

  it('keeps a stable status channel and announces counts only after results settle', () => {
    query.mockReturnValue(result({ isLoading: true, isFetching: true, data: undefined }))
    const { rerender } = render(column())
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Planned: Loading...')
    query.mockReturnValue(result({ data: { pages: [{ items: [], total: 1200 }] } }))
    rerender(column())
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Planned: 1,200')

    query.mockReturnValue(
      result({
        data: { pages: [{ items: [], total: 1200 }] },
        isFetching: true,
      })
    )
    rerender(column())
    expect(status).toHaveTextContent('Loading...')
    expect(status).not.toHaveTextContent('1,200')
  })

  it('does not announce cached or placeholder counts as a successful result', () => {
    query.mockReturnValue(
      result({
        data: { pages: [{ items: [], total: 12 }] },
        isPlaceholderData: true,
      })
    )
    const { rerender } = render(column())
    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
    expect(screen.getByRole('status')).not.toHaveTextContent('12')
    expect(screen.queryByText('No items yet')).not.toBeInTheDocument()
    expect(screen.queryByText('No posts match your filters.')).not.toBeInTheDocument()

    query.mockReturnValue(result({ isError: true }))
    rerender(column())
    expect(screen.getByRole('alert')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent(/^$/)
  })

  it('retains the permission explanation instead of claiming zero matching items', () => {
    render(column({ search: 'missing' }, true))
    expect(screen.getByRole('status')).toHaveTextContent('Sign in to view roadmap items.')
    expect(screen.getByRole('status')).not.toHaveTextContent('Planned: 0')
    expect(screen.queryByText('No posts match your filters.')).not.toBeInTheDocument()
  })

  it('keeps an initially paused query pending rather than presenting an empty result', () => {
    query.mockReturnValue(result({ isPending: true, data: undefined }))
    render(column({ search: 'missing' }))
    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
    expect(screen.queryByText('No posts match your filters.')).not.toBeInTheDocument()
    expect(screen.queryByText('No items yet')).not.toBeInTheDocument()
  })

  it('does not convert a missing response total into a zero result', () => {
    query.mockReturnValue(result({ data: undefined }))
    render(column())
    expect(screen.getByRole('status')).toHaveTextContent(/^$/)
  })
})

describe('Roadmap selection query continuity', () => {
  it.each([undefined, 'roadmap_previous'])('retains query, sort and facets from %s', (roadmap) => {
    const search = {
      roadmap,
      search: 'connector',
      sort: 'oldest',
      board: ['board_example'],
      tags: ['tag_example'],
      segments: ['segment_example'],
    }
    routeSearch.mockReturnValue(search)
    const { result: selection } = renderHook(() => usePublicRoadmapSelection())
    act(() => selection.current.setSelectedRoadmap('roadmap_next'))
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      to: '/roadmap',
      search: { ...search, roadmap: 'roadmap_next' },
      replace: true,
    })
  })
})

// venturi-systems/feedback#369: with no roadmap in the address, the board wrote
// its default on every render, also after the visitor had clicked Home and
// before that navigation committed, which replaced Home with the roadmap.
describe('Roadmap default selection', () => {
  const first = 'roadmap_first' as RoadmapId

  function renderSelection(defaultRoadmapId: RoadmapId | null = first) {
    return renderHook(({ id }) => usePublicRoadmapSelection(id), {
      initialProps: { id: defaultRoadmapId },
    })
  }

  it('writes the default once the router settles on the roadmap', () => {
    routeSearch.mockReturnValue({ sort: 'oldest' })
    routerIs(routerAt('/roadmap?sort=oldest', '/'))
    const { rerender } = renderSelection()
    expect(navigate).not.toHaveBeenCalled()

    routerIs(routerAt('/roadmap?sort=oldest'))
    rerender({ id: first })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({
      to: '/roadmap',
      search: { sort: 'oldest', roadmap: 'roadmap_first' },
      replace: true,
    })
  })

  it('does not replace a navigation that starts after the board renders', () => {
    renderedRouter.mockReturnValue(routerAt('/roadmap'))
    liveRouter.mockReturnValue(routerAt('/', '/roadmap'))
    const { rerender } = renderSelection()
    expect(navigate).not.toHaveBeenCalled()

    // The board re-renders before Home commits: a query settles, a scroll.
    routerIs(routerAt('/', '/roadmap'))
    rerender({ id: first })
    rerender({ id: first })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not navigate back after a navigation away has already settled', () => {
    // Home commits after the board renders and before its effect runs, so the
    // router is settled again, at the new address.
    renderedRouter.mockReturnValue(routerAt('/roadmap'))
    liveRouter.mockReturnValue(routerAt('/'))
    renderSelection()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('writes the default when the idle address is encoded or ordered differently', () => {
    // The guard reads the router's status, not a comparison of two hrefs that
    // could differ in encoding or parameter order while nothing is pending.
    routeSearch.mockReturnValue({ sort: 'oldest', search: 'a b' })
    routerIs({
      ...routerAt('/roadmap?sort=oldest&search=a%20b'),
      resolvedLocation: { href: '/roadmap?search=a+b&sort=oldest', pathname: '/roadmap' },
    })
    renderSelection()
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('writes the default once while its own navigation is pending', () => {
    const { rerender } = renderSelection()
    expect(navigate).toHaveBeenCalledTimes(1)

    routerIs(routerAt('/roadmap?roadmap=roadmap_first', '/roadmap'))
    rerender({ id: first })
    rerender({ id: first })
    expect(navigate).toHaveBeenCalledTimes(1)

    routeSearch.mockReturnValue({ roadmap: 'roadmap_first' })
    routerIs(routerAt('/roadmap?roadmap=roadmap_first'))
    rerender({ id: first })
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('keeps a roadmap the address already names', () => {
    routeSearch.mockReturnValue({ roadmap: 'roadmap_previous' })
    renderSelection()
    expect(navigate).not.toHaveBeenCalled()
  })
})
