// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VenturiLandingFooter } from '../venturi-landing-footer'
import { PublicPageFrame } from '../public-page-frame'
import { sourceCodeUrl } from '@/lib/shared/venturi-identity'

describe('REQ-FEEDBACK-AUTH-VIEWPORT: authentication utilities', () => {
  it('retains versioned source access and Sitemap without a marketing footer or notices link', () => {
    render(<VenturiLandingFooter />)
    const commit = typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : null
    expect(screen.getByRole('link', { name: 'Source code' })).toHaveAttribute(
      'href',
      sourceCodeUrl(commit)
    )
    expect(screen.getByRole('link', { name: 'Sitemap' })).toHaveAttribute(
      'href',
      'https://venturi.systems/sitemap/'
    )
    expect(screen.getAllByRole('link')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'Software notices' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Footer' })).not.toBeInTheDocument()
    expect(screen.queryByText('The attribution layer for AI.')).not.toBeInTheDocument()
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
