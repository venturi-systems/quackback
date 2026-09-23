// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let hydrated = false
vi.mock('@tanstack/react-router', () => ({
  useHydrated: () => hydrated,
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}))
vi.mock('@/lib/server/functions/public-posts', () => ({ findSimilarPostsFn: vi.fn() }))

import { SimilarPostsSection, similarPostsQuery } from '../similar-posts-section'

const TITLE = 'Dark mode support'
const related = [
  { id: 'post_current', title: TITLE, boardSlug: 'features', voteCount: 3, status: null },
  {
    id: 'post_other',
    title: 'Dark theme for email',
    boardSlug: 'features',
    voteCount: 7,
    status: { name: 'Planned', color: '#7c3aed' },
  },
  { id: 'post_single', title: 'Dark code blocks', boardSlug: 'bugs', voteCount: 1, status: null },
]

function renderSection() {
  const queryClient = new QueryClient()
  // The route's non-blocking prefetch can land before hydration: the cache
  // already holds the result when the client first renders.
  queryClient.setQueryData(similarPostsQuery(TITLE).queryKey, related)
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" defaultLocale="en">
        <SimilarPostsSection postTitle={TITLE} currentPostId={'post_current' as never} />
      </IntlProvider>
    </QueryClientProvider>
  )
}

describe('SimilarPostsSection', () => {
  beforeEach(() => {
    hydrated = false
  })

  it('renders nothing before hydration, matching the server render', () => {
    const { container } = renderSection()
    expect(container).toBeEmptyDOMElement()
  })

  it('lists related posts other than the current one once hydrated', () => {
    hydrated = true
    renderSection()
    expect(screen.getByText('Related')).toBeInTheDocument()
    expect(screen.getByText('Dark theme for email')).toBeInTheDocument()
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('states votes in words and status by name, with no vote control', () => {
    hydrated = true
    renderSection()
    expect(screen.getByText('7 votes')).toBeInTheDocument()
    expect(screen.getByText('1 vote')).toBeInTheDocument()
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
