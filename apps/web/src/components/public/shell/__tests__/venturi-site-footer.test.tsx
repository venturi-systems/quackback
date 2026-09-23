// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VenturiSiteFooter } from '../venturi-site-footer'

// The footer mirrors the public website's contract (landing-page
// src/content/site.ts legalLinks): the same five legal links, in the same
// order, with the same labels, after the related sites and the AGPL link.
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

  it('names the copyright holder and links the related sites and the source', () => {
    render(<VenturiSiteFooter />)

    const footer = screen.getByRole('contentinfo')
    expect(
      within(footer).getByText(`© ${new Date().getFullYear()} Venturi Systems, Inc.`)
    ).toBeInTheDocument()
    const related = within(footer).getByRole('navigation', { name: 'Related Venturi sites' })
    expect(within(related).getByRole('link', { name: 'Venturi' })).toHaveAttribute(
      'href',
      'https://venturi.systems/'
    )
    expect(within(related).getByRole('link', { name: 'Documentation' })).toHaveAttribute(
      'href',
      'https://docs.venturi.systems/'
    )
    // Tests do not define the build commit, so the AGPL link names the
    // repository rather than a commit.
    expect(within(related).getByRole('link', { name: 'Source code (AGPL-3.0)' })).toHaveAttribute(
      'href',
      'https://github.com/venturi-systems/quackback'
    )
  })
})
