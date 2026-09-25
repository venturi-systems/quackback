// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import type { RoadmapId, StatusId } from '@quackback/ids'
import type { RoadmapFilters } from '@/lib/shared/types'

const { query, navigate, routeSearch } = vi.hoisted(() => ({
  query: vi.fn(),
  navigate: vi.fn(),
  routeSearch: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
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

beforeEach(() => {
  query.mockReturnValue(result())
  navigate.mockClear()
  routeSearch.mockReturnValue({})
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

  it.each([
    { board: ['board_test'] },
    { tags: ['tag_test'] },
    { segmentIds: ['segment_test'] },
  ])('recognizes facet-only no-match states: %j', (filters) => {
    render(column(filters))
    expect(screen.getByText('No posts match your filters.')).toBeVisible()
  })

  it('keeps a stable status channel and announces counts only after results settle', () => {
    query.mockReturnValue(result({ isLoading: true, isFetching: true, data: undefined }))
    const { rerender } = render(column())
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Planned: Loading...')
    query.mockReturnValue(result({ data: { pages: [{ items: [], total: 1200 }] } }))
    rerender(column())
    expect(screen.getByRole('status')).toBe(status)
    expect(status).toHaveTextContent('Planned: 1,200')

    query.mockReturnValue(result({
      data: { pages: [{ items: [], total: 1200 }] },
      isFetching: true,
    }))
    rerender(column())
    expect(status).toHaveTextContent('Loading...')
    expect(status).not.toHaveTextContent('1,200')
  })

  it('does not announce cached or placeholder counts as a successful result', () => {
    query.mockReturnValue(result({
      data: { pages: [{ items: [], total: 12 }] },
      isPlaceholderData: true,
    }))
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
