// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it, vi } from 'vitest'

// The scroll affordances depend on real layout; the tab labels do not.
vi.mock('@/lib/client/hooks/use-pills-scroll', () => ({
  usePillsScroll: () => ({
    ref: { current: null },
    canScrollLeft: false,
    canScrollRight: false,
    scrollBy: vi.fn(),
  }),
}))

import { RoadmapTabs } from '../roadmap-tabs'

const ROADMAPS = [
  { id: 'roadmap_1', name: 'Product roadmap' },
  {
    id: 'roadmap_2',
    name: 'Integrations and data connectors planned for the second half of the year',
  },
]

function renderTabs(onSelect = vi.fn()) {
  render(
    <IntlProvider locale="en" messages={{}}>
      <RoadmapTabs roadmaps={ROADMAPS} selectedId="roadmap_1" onSelect={onSelect} />
    </IntlProvider>
  )
  return onSelect
}

describe('public RoadmapTabs (REQ-07: v6.6 text rules)', () => {
  it('does not force admin-written tab labels onto one line', () => {
    renderTabs()
    for (const tab of screen.getAllByRole('tab')) {
      // v6.6 prohibits nowrap as a typography remedy; a long label reflows.
      expect(tab.className).not.toMatch(/\bwhitespace-nowrap\b/)
      // Tabs keep their size in the scrollable row, and a wrapped tab stops
      // short of the row by both scroll affordances so it can be read whole.
      expect(tab.className).toMatch(/\bshrink-0\b/)
      expect(tab.className).toContain(
        'max-w-[calc(100%_-_2*max(2.625rem,var(--ds-component-touch-minimum)))]'
      )
      // A tall, wrapped tab uses the 24px token radius, not a capsule whose
      // corners would cut into its first and last lines.
      expect(tab.className).toContain('rounded-(--ds-primitive-dimension-radius-24)')
      expect(tab.className).not.toMatch(/\brounded-full\b/)
    }
  })

  it('marks each label as user text and keeps it whole', () => {
    renderTabs()
    for (const roadmap of ROADMAPS) {
      const tab = screen.getByRole('tab', { name: roadmap.name })
      const label = tab.querySelector('[data-text-origin="user"]')
      expect(label).not.toBeNull()
      expect(label).toHaveTextContent(roadmap.name)
    }
  })

  it('keeps the tab semantics and selection', () => {
    const onSelect = renderTabs()
    expect(screen.getByRole('tablist', { name: 'Roadmaps' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Product roadmap' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    fireEvent.click(screen.getByRole('tab', { name: ROADMAPS[1].name }))
    expect(onSelect).toHaveBeenCalledWith('roadmap_2')
  })
})
