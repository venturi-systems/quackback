// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VenturiSiteFooter } from '../venturi-site-footer'

// The footer mirrors the public website's contract (landing-page
// src/content/site.ts legalLinks): the same five legal links, in the same
// order, immediately after copyright, below Product / Trust / Connect.
describe('VenturiSiteFooter', () => {
  it('ends with the legal row in the public website order and labels', () => {
    render(<VenturiSiteFooter />)

    const legal = screen.getByRole('navigation', { name: 'Legal and sitemap' })
    const links = within(legal).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Sitemap', 'https://venturi.systems/sitemap/'],
      ['Terms of service', 'https://venturi.systems/legal/terms-of-service/'],
      ['Privacy policy', 'https://venturi.systems/legal/privacy/'],
      ['Data protection addendum', 'https://venturi.systems/legal/dpa/'],
      ['Master Services Agreement', 'https://venturi.systems/legal/master-services-agreement/'],
    ])
  })

  it('groups navigation consistently with the marketing footer', () => {
    render(<VenturiSiteFooter />)
    const product = screen.getByRole('region', { name: 'Product' })
    expect(
      within(product)
        .getAllByRole('link')
        .map((link) => link.textContent?.replace(' ↗', '').trim())
    ).toEqual([
      'Use Cases',
      'How It Works',
      'Platform',
      'Documentation',
      'Pricing',
      'Product demo (opens in a new tab)',
      'Login',
    ])
    expect(screen.queryByRole('link', { name: 'Deployment' })).not.toBeInTheDocument()
    const demo = screen.getByRole('link', { name: /Product demo/ })
    expect(demo).toHaveAttribute('target', '_blank')
    expect(demo).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link', { name: 'Legal' })).toHaveAttribute(
      'href',
      'https://venturi.systems/legal/'
    )
  })
  it('keeps copyright and sitemap adjacent in the same compact legal list', () => {
    render(<VenturiSiteFooter />)
    const legal = screen.getByRole('navigation', { name: 'Legal and sitemap' })
    const items = within(legal).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Venturi Systems, Inc.')
    expect(items[1]).toHaveTextContent('Sitemap')
    expect(screen.queryByRole('link', { name: /Source code/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Software notices' })).toHaveAttribute(
      'href',
      '/software-notices'
    )
  })
})
