// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return { ...actual, useQuery: () => ({ data: undefined }) }
})
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}))
vi.mock('@/lib/client/queries/portal-detail', () => ({
  portalDetailQueries: { voteSidebarData: () => ({ queryKey: ['vote-sidebar-data'] }) },
}))
// These tests read the picker contents, so each popover renders them in place.
vi.mock('@/components/ui/popover', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return { Popover: Pass, PopoverTrigger: Pass, PopoverContent: Pass }
})
vi.mock('@/components/public/auth-vote-button', () => ({ AuthVoteButton: () => null }))
vi.mock('@/components/public/auth-subscription-bell', () => ({
  AuthSubscriptionBell: () => null,
}))
vi.mock('@/components/admin/feedback/voters-avatar-stack', () => ({
  VotersAvatarStack: () => null,
}))
vi.mock('@/components/shared/status-dropdown', () => ({ StatusDropdown: () => null }))

import { MetadataSidebar } from '../metadata-sidebar'

// Admins write board and roadmap names; these are longer than any chip or
// picker row, and each is the only thing that tells its choice apart.
const LONG_ROADMAP = 'Integrations and data connectors planned for the second half of the year'
const OTHER_ROADMAP = 'Accessibility, localization and right-to-left language support'
const LONG_BOARD = 'Customer requests from enterprise workspace administrators'

function renderSidebar() {
  const noop = vi.fn(async () => {})
  return render(
    <IntlProvider locale="en" messages={{}}>
      <MetadataSidebar
        postId={'post_1' as never}
        voteCount={3}
        board={{ id: 'board_1', name: 'Feature requests', slug: 'features' }}
        authorName="Demo User"
        createdAt={new Date('2026-09-01T12:00:00Z')}
        roadmaps={[{ id: 'roadmap_1', name: LONG_ROADMAP, slug: 'integrations' }]}
        allRoadmaps={[
          { id: 'roadmap_1', name: LONG_ROADMAP, slug: 'integrations' },
          { id: 'roadmap_2', name: OTHER_ROADMAP, slug: 'accessibility' },
        ]}
        allBoards={[
          { id: 'board_1', name: 'Feature requests', slug: 'features' },
          { id: 'board_2', name: LONG_BOARD, slug: 'enterprise' },
        ]}
        canEdit
        onRoadmapAdd={noop}
        onRoadmapRemove={noop}
        onBoardChange={noop}
        hideSubscribe
        hideVote
      />
    </IntlProvider>
  )
}

const TRUNCATION = /\b(truncate|line-clamp-\d+|whitespace-nowrap|text-ellipsis)\b|max-w-\[\d+px\]/

function expectWholeUserLabel(name: string) {
  const label = screen.getByText(name)
  // v6.6: an admin-written name is shown whole and wraps, never cut short.
  expect(label).toHaveAttribute('data-text-origin', 'user')
  expect(label.className).not.toMatch(TRUNCATION)
  expect(label.className).toMatch(/\bbreak-words\b/)
  expect(label.className).toMatch(/\bmin-w-0\b/)
  expect(label).toHaveTextContent(name)
  return label
}

describe('MetadataSidebar: admin-written names (REQ-07, v6.6 text rules)', () => {
  it('shows a post roadmap chip name whole, wrapping inside the chip', () => {
    renderSidebar()
    const label = expectWholeUserLabel(LONG_ROADMAP)
    const chip = label.closest('button')
    expect(chip).not.toBeNull()
    // The chip may be as wide as its row, and its icons keep their size
    // beside a wrapped name.
    expect(chip!.className).toMatch(/\bmax-w-full\b/)
    for (const icon of chip!.querySelectorAll('svg')) {
      expect(icon.getAttribute('class')).toMatch(/\bshrink-0\b/)
    }
  })

  it('shows each roadmap name whole in the add-to-roadmap picker', () => {
    renderSidebar()
    const label = expectWholeUserLabel(OTHER_ROADMAP)
    expect(label.closest('button')!.querySelector('svg')!.getAttribute('class')).toMatch(
      /\bshrink-0\b/
    )
  })

  it('shows each board name whole in the board picker', () => {
    renderSidebar()
    expectWholeUserLabel(LONG_BOARD)
  })
})
