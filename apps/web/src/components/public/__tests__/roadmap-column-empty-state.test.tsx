// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RoadmapColumn } from '../roadmap-column'

const mockUsePublicRoadmapPosts = vi.fn()

vi.mock('@/lib/client/hooks/use-roadmap-posts-query', () => ({
  usePublicRoadmapPosts: (...args: unknown[]) => mockUsePublicRoadmapPosts(...args),
  flattenRoadmapPostEntries: () => [],
}))

function renderColumn(signInRequiredForItems = false) {
  mockUsePublicRoadmapPosts.mockReturnValue({
    data: { pages: [{ total: 0 }] },
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isLoading: false,
  })

  return render(
    <IntlProvider locale="en" messages={{}}>
      <RoadmapColumn
        roadmapId={'roadmap_test' as `roadmap_${string}`}
        statusId={'status_test' as `status_${string}`}
        title="Planned"
        color="#a855f7"
        signInRequiredForItems={signInRequiredForItems}
      />
    </IntlProvider>
  )
}

describe('RoadmapColumn empty state', () => {
  beforeEach(() => {
    mockUsePublicRoadmapPosts.mockReset()
  })

  it('uses the ordinary empty state when roadmap items are viewable', () => {
    renderColumn()

    expect(screen.getByText('No items yet')).toBeInTheDocument()
    expect(screen.queryByText('Sign in to view roadmap items.')).not.toBeInTheDocument()
    // A genuinely empty column shows its zero count.
    expect(screen.getByText('0')).toBeInTheDocument()
  })

  it('uses an auth-aware empty state when anonymous visitors have no viewable boards', () => {
    renderColumn(true)

    expect(screen.getByText('Sign in to view roadmap items.')).toBeInTheDocument()
    expect(screen.queryByText('No items yet')).not.toBeInTheDocument()
    // The true count is unknown to a signed-out visitor — no misleading "0" badge.
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })
})
