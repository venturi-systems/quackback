// @vitest-environment happy-dom
/**
 * <HelpCenterBreadcrumbs> renders the trail above help-center category and
 * article pages. By default the last crumb names the current page and renders
 * as text. The article page shows its title in an h1, so it ends the trail at
 * the category and passes `currentIsLast={false}` to keep that category a link
 * (venturi-systems/feedback#451). The e2e suite
 * (e2e/tests/public/help-center.spec.ts) clicks that link in a browser; these
 * tests pin both modes without a server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { HelpCenterBreadcrumbs } from '../help-center-breadcrumbs'
import { buildCategoryBreadcrumbs } from '../help-center-utils'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

afterEach(cleanup)

const CATEGORIES = [{ id: 'c1', slug: 'billing', name: 'Billing', parentId: null }]

function breadcrumbNav() {
  return screen.getByRole('navigation', { name: 'Breadcrumb' })
}

describe('HelpCenterBreadcrumbs', () => {
  it('renders the last crumb as text by default, even when it has an href', () => {
    render(
      <HelpCenterBreadcrumbs
        items={[
          { label: 'Help Center', href: '/hc' },
          { label: 'Billing', href: '/hc/categories/billing' },
        ]}
      />
    )

    const nav = breadcrumbNav()
    const links = within(nav).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/hc')
    expect(within(nav).getByText('Billing').tagName).toBe('SPAN')
  })

  it('links the last crumb when currentIsLast is false and the crumb has an href', () => {
    render(
      <HelpCenterBreadcrumbs
        currentIsLast={false}
        items={[
          { label: 'Help Center', href: '/hc' },
          { label: 'Billing', href: '/hc/categories/billing' },
        ]}
      />
    )

    const links = within(breadcrumbNav()).getAllByRole('link')
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/hc',
      '/hc/categories/billing',
    ])
    expect(links[1]).toHaveTextContent('Billing')
  })

  it('keeps a crumb without an href as text when currentIsLast is false', () => {
    render(
      <HelpCenterBreadcrumbs
        currentIsLast={false}
        items={[{ label: 'Help Center', href: '/hc' }, { label: 'Billing' }]}
      />
    )

    const nav = breadcrumbNav()
    expect(within(nav).getAllByRole('link')).toHaveLength(1)
    expect(within(nav).getByText('Billing').tagName).toBe('SPAN')
  })

  it('links the category on the article page trail', () => {
    // Mirrors the article route: the builder adds the article title as the
    // final crumb, the route drops it because the h1 shows it, and the
    // category that remains must link back to its category page.
    const breadcrumbs = buildCategoryBreadcrumbs({
      allCategories: CATEGORIES,
      categoryId: 'c1',
      articleTitle: 'Update your billing details',
    })
    render(<HelpCenterBreadcrumbs items={breadcrumbs.slice(0, -1)} currentIsLast={false} />)

    const nav = breadcrumbNav()
    expect(within(nav).getByRole('link', { name: 'Billing' })).toHaveAttribute(
      'href',
      '/hc/categories/billing'
    )
    expect(within(nav).queryByText('Update your billing details')).not.toBeInTheDocument()
  })

  it('leaves the category as the current page on the category page trail', () => {
    const breadcrumbs = buildCategoryBreadcrumbs({ allCategories: CATEGORIES, categoryId: 'c1' })
    render(<HelpCenterBreadcrumbs items={breadcrumbs} />)

    const nav = breadcrumbNav()
    expect(within(nav).queryByRole('link', { name: 'Billing' })).not.toBeInTheDocument()
    expect(within(nav).getByText('Billing')).toHaveClass('font-medium')
  })
})
