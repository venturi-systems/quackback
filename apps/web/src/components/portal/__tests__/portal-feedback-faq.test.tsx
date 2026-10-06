// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it } from 'vitest'
import { PortalFeedbackFaq } from '../portal-feedback-faq'

describe('authenticated feedback help', () => {
  it('provides discoverable answers without pretending that votes promise delivery', () => {
    const { container } = render(
      <IntlProvider locale="en">
        <PortalFeedbackFaq />
      </IntlProvider>
    )
    expect(screen.getByRole('region', { name: 'Feedback FAQ' })).toBeInTheDocument()
    expect(container.querySelectorAll('details')).toHaveLength(4)
    expect(screen.getByText('How do I suggest an improvement?')).toBeInTheDocument()
    expect(screen.getByText(/do not guarantee a delivery date/)).toBeInTheDocument()
    expect(screen.queryByText('Who can do what')).not.toBeInTheDocument()
  })
})
