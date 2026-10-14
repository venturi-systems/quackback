// @vitest-environment happy-dom
/**
 * <HelpCenterCategoryGrid> is the category list on the public help-center
 * landing page. The e2e suite (e2e/tests/public/help-center.spec.ts) creates
 * its own categories, so it always sees the populated grid; the empty state a
 * new workspace shows is asserted here instead, where no data is needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { HelpCenterCategoryGrid } from '../help-center-category-grid'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

afterEach(cleanup)

const EMPTY_STATE = 'No categories yet. Check back soon.'

function category(overrides: { id: string; slug: string; name: string; parentId?: string | null }) {
  return {
    icon: null,
    description: null,
    articleCount: 1,
    ...overrides,
  }
}

describe('HelpCenterCategoryGrid', () => {
  it('shows the empty state and no category link when there are no categories', () => {
    render(<HelpCenterCategoryGrid categories={[]} />)

    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument()
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })

  it('shows the empty state when every category is a subcategory', () => {
    // The grid lists top-level categories only, so subcategories alone leave
    // the landing page with nothing to show.
    render(
      <HelpCenterCategoryGrid
        categories={[category({ id: 'c2', slug: 'invoices', name: 'Invoices', parentId: 'c1' })]}
      />
    )

    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument()
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument()
  })

  it('lists top-level categories instead of the empty state', () => {
    render(
      <HelpCenterCategoryGrid
        categories={[
          category({ id: 'c1', slug: 'billing', name: 'Billing', parentId: null }),
          category({ id: 'c2', slug: 'invoices', name: 'Invoices', parentId: 'c1' }),
        ]}
      />
    )

    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument()
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/hc/categories/billing')
    expect(links[0]).toHaveTextContent('Billing')
  })
})
