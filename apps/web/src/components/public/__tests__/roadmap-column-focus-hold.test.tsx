// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it, vi } from 'vitest'

const useInfiniteScroll = vi.fn((_options: unknown) => ({ current: null }))

vi.mock('@/lib/client/hooks/use-infinite-scroll', () => ({
  useInfiniteScroll: (options: unknown) => useInfiniteScroll(options),
}))
vi.mock('@/lib/client/hooks/use-roadmap-posts-query', () => ({
  usePublicRoadmapPosts: () => ({
    data: { pages: [{ total: 30 }] },
    isFetchingNextPage: false,
    hasNextPage: true,
    fetchNextPage: vi.fn(),
    isLoading: false,
  }),
  flattenRoadmapPostEntries: () => [],
}))

import { RoadmapColumn } from '../roadmap-column'

describe('RoadmapColumn: keyboard focus below the board (WCAG 2.4.11)', () => {
  it('holds loading while focus follows the column and keeps a focused element in place', () => {
    // The board has no fixed height: a page arriving in a column pushes the
    // footer down. The render check's keyboard walk saw a focused footer link
    // pushed out of the viewport (run 36075134195). The hook's hold keeps it
    // in place, as it does for the feed.
    render(
      <IntlProvider locale="en" messages={{}}>
        <RoadmapColumn
          roadmapId={'roadmap_test' as `roadmap_${string}`}
          statusId={'status_test' as `status_${string}`}
          title="Planned"
          color="#a855f7"
        />
      </IntlProvider>
    )

    expect(useInfiniteScroll).toHaveBeenCalled()
    expect(useInfiniteScroll.mock.calls.at(-1)?.[0]).toMatchObject({
      hasMore: true,
      holdWhileFocusFollows: true,
    })
  })
})
