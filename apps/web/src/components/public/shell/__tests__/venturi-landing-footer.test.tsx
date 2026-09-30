// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VenturiLandingFooter } from '../venturi-landing-footer'
import { PublicPageFrame } from '../public-page-frame'
import { VENTURI_LEGAL_LINKS } from '@/lib/shared/venturi-identity'

describe('REQ-FEEDBACK-ENTRY: marketing footer', () => {
  it('retains the marketing groups, destinations, legal order and quiet source access', () => {
    render(<VenturiLandingFooter />)
    expect(screen.getByText('The attribution layer for AI.')).toBeInTheDocument()
    const footer = screen.getByRole('navigation', { name: 'Footer' })
    expect(
      within(footer)
        .getAllByRole('heading')
        .map((item) => item.textContent)
    ).toEqual(['Product', 'Trust', 'Connect'])
    expect(
      within(footer)
        .getAllByRole('link')
        .map((item) => [item.textContent, item.getAttribute('href')])
    ).toEqual([
      ['Use Cases', 'https://venturi.systems/use-cases/'],
      ['How It Works', 'https://venturi.systems/how-it-works/'],
      ['Platform', 'https://venturi.systems/platform/'],
      ['Documentation', 'https://docs.venturi.systems/'],
      ['Security', 'https://venturi.systems/security/'],
      ['Deployment', 'https://venturi.systems/platform/'],
      ['Privacy', 'https://venturi.systems/legal/privacy/'],
      ['Contact', 'https://venturi.systems/contact/'],
      ['Careers', 'https://venturi.systems/careers/'],
      ['Feedback', 'https://feedback.venturi.systems/'],
      ['Login', 'https://app.venturi.systems/'],
    ])
    const legal = screen.getByRole('navigation', { name: 'Legal and sitemap' })
    expect(
      within(legal)
        .getAllByRole('link')
        .map((item) => ({ label: item.textContent, href: item.getAttribute('href') }))
    ).toEqual(VENTURI_LEGAL_LINKS)
    expect(screen.getByRole('link', { name: 'Back to top ↑' })).toHaveAttribute(
      'href',
      '#feedback-entry-top'
    )
    expect(screen.getByRole('link', { name: 'Software notices' })).toHaveAttribute(
      'href',
      '/software-notices'
    )
    expect(screen.queryByRole('link', { name: /source code/i })).not.toBeInTheDocument()
  })

  it('keeps the shared frame default footer and applies replacement only when supplied', () => {
    const { rerender } = render(<PublicPageFrame>Content</PublicPageFrame>)
    expect(screen.getByTestId('venturi-site-footer')).toBeInTheDocument()
    expect(screen.queryByTestId('venturi-landing-footer')).not.toBeInTheDocument()
    rerender(<PublicPageFrame footer={<VenturiLandingFooter />}>Content</PublicPageFrame>)
    expect(screen.getByTestId('venturi-landing-footer')).toBeInTheDocument()
    expect(screen.queryByTestId('venturi-site-footer')).not.toBeInTheDocument()
  })
})
