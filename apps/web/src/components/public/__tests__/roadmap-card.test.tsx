// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RoadmapCard } from '../roadmap-card'

// The card is a navigation link; a plain anchor stands in for the router Link.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    params,
    className,
  }: {
    children: ReactNode
    params: { slug: string; postId: string }
    className?: string
  }) => (
    <a href={`/b/${params.slug}/posts/${params.postId}`} className={className}>
      {children}
    </a>
  ),
}))

function renderCard(voteCount: number) {
  return render(
    <IntlProvider locale="en" messages={{}}>
      <RoadmapCard
        id="post_1"
        title="Export feedback to CSV"
        voteCount={voteCount}
        board={{ slug: 'feature-requests', name: 'Feature requests' }}
      />
    </IntlProvider>
  )
}

describe('public RoadmapCard (E-7: no fake voting control)', () => {
  it('states the vote count in words with its object', () => {
    renderCard(12)
    expect(screen.getByText('12 votes')).toBeInTheDocument()
  })

  it('uses the singular for one vote and keeps zero as a real count', () => {
    const { unmount } = renderCard(1)
    expect(screen.getByText('1 vote')).toBeInTheDocument()
    unmount()
    renderCard(0)
    expect(screen.getByText('0 votes')).toBeInTheDocument()
  })

  it('is a single link to the post and exposes no button or icon-only count', () => {
    const { container } = renderCard(256)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/b/feature-requests/posts/post_1')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // The old card drew an upvote chevron beside a bare number.
    expect(container.querySelector('.roadmap-card__vote')).toBeNull()
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(link.textContent).toContain('256 votes')
  })

  it('marks the post title and board name as user-generated text', () => {
    renderCard(3)
    expect(screen.getByText('Export feedback to CSV')).toHaveAttribute('data-text-origin', 'user')
    expect(screen.getByText('Feature requests')).toHaveAttribute('data-text-origin', 'user')
  })
})
