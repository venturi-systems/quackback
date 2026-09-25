// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it, vi } from 'vitest'

// The card measures its content to animate its height; layout is not under test.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)
vi.mock('@/components/public/vote-button', () => ({ VoteButton: () => null }))

import { SimilarPostsCard } from '../similar-posts-card'

// Another member wrote this title; it is longer than the card is wide.
const LONG_TITLE =
  'Let workspace administrators export every board, including archived feedback, to CSV'

describe('SimilarPostsCard: a similar idea title (REQ-07, v6.6 text rules)', () => {
  it('shows the whole title, marked as user text, wrapping instead of clamped', () => {
    render(
      <IntlProvider locale="en" messages={{}}>
        <SimilarPostsCard
          show
          posts={[
            {
              id: 'post_1',
              title: LONG_TITLE,
              voteCount: 4,
              status: null,
              boardSlug: 'features',
              matchStrength: 'strong',
            },
          ]}
        />
      </IntlProvider>
    )
    const title = screen.getByText(LONG_TITLE)
    expect(title).toHaveAttribute('data-text-origin', 'user')
    expect(title.className).not.toMatch(/\b(truncate|line-clamp-\d+|whitespace-nowrap)\b/)
    expect(title.className).toMatch(/\bbreak-words\b/)
    expect(title).toHaveTextContent(LONG_TITLE)
    expect(title.closest('a')).toHaveAttribute('href', '/b/features/posts/post_1')
  })
})
