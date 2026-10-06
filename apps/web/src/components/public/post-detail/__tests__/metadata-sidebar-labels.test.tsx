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

function renderSidebar(
  author: { authorName?: string | null; authorPrincipalId?: string | null } = {}
) {
  const noop = vi.fn(async () => {})
  return render(
    <IntlProvider locale="en" messages={{}}>
      <MetadataSidebar
        postId={'post_1' as never}
        voteCount={3}
        board={{ id: 'board_1', name: 'Feature requests', slug: 'features' }}
        authorName={'authorName' in author ? author.authorName! : 'Demo User'}
        authorPrincipalId={author.authorPrincipalId}
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

// The seed gives each run a different author, so the render lane measures a
// different name and different initials every time.
const LONG_AUTHOR = 'Marcus Thompson'

describe('MetadataSidebar: author row', () => {
  it.each([
    ['plain', undefined],
    ['linked to the user detail', 'principal_1'],
  ])('marks a real author name as user text in the %s row', (_label, authorPrincipalId) => {
    renderSidebar({ authorName: LONG_AUTHOR, authorPrincipalId })
    expectWholeUserLabel(LONG_AUTHOR)
  })

  it('keeps the Anonymous fallback as page copy', () => {
    renderSidebar({ authorName: null })
    const label = screen.getByText('Anonymous')
    // The design suite checker reads the nearest data-text-origin ancestor.
    expect(label.closest('[data-text-origin]')).toBeNull()
  })

  it('lets the avatar widen for wide initials instead of clipping them', async () => {
    renderSidebar({ authorName: LONG_AUTHOR })
    // Radix renders the fallback after a zero-delay timer.
    const initials = await screen.findByText('MT')
    expect(initials.className).toMatch(/\bpx-1\b/)
    const avatar = initials.closest('[data-slot="avatar"]')
    expect(avatar).not.toBeNull()
    expect(avatar!.className).toMatch(/\bw-auto\b/)
    expect(avatar!.className).toMatch(/\bmin-w-5\b/)
    // The fixed 20px width clipped two wide initials under text spacing.
    expect(avatar!.className.split(/\s+/)).not.toContain('w-5')
  })
})
