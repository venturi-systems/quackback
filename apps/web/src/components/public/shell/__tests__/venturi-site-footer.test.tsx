// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VenturiSiteFooter } from '../venturi-site-footer'

afterEach(() => vi.unstubAllGlobals())

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
    ).toEqual(['Use Cases', 'How It Works', 'Platform', 'Documentation', 'Pricing', 'Login'])
    expect(screen.queryByRole('link', { name: 'Deployment' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Product demo/ })).not.toBeInTheDocument()
    for (const link of screen.getAllByRole('link')) {
      const path = new URL(link.getAttribute('href')!, 'https://feedback.venturi.systems').pathname
      expect(path).not.toMatch(/^\/(?:investor\/)?demo(?:\/|$)/)
    }
    expect(
      within(screen.getByRole('region', { name: 'Connect' }))
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Contact', 'Careers', 'Feedback'])
    expect(screen.getByRole('link', { name: 'Legal' })).toHaveAttribute(
      'href',
      'https://venturi.systems/legal/'
    )
  })
  it('offers the exact build source in Trust when the anonymous entry requests it', () => {
    const commit = 'cef28adb3a25b25ef116534bb3673c68fcda7abd'
    vi.stubGlobal('__GIT_COMMIT__', commit)
    render(<VenturiSiteFooter showSourceCode />)
    const trust = screen.getByRole('region', { name: 'Trust' })
    expect(within(trust).getByRole('link', { name: 'Source code' })).toHaveAttribute(
      'href',
      `https://github.com/venturi-systems/quackback/tree/${commit}`
    )
    expect(within(trust).getByRole('link', { name: 'Software notices' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Source code' })).toHaveLength(1)
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
