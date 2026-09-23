// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { describe, expect, it } from 'vitest'
import { PortalParticipation } from '../portal-participation'

// E-18: on phones the explainer collapses into a disclosure so the composer
// and the first posts stay in the first viewport; wide screens show it open.
// Both renderings carry the same three statements; CSS shows exactly one.
describe('PortalParticipation', () => {
  it('renders the statements in a disclosure and in the wide list', () => {
    const { container } = render(
      <IntlProvider locale="en" defaultLocale="en">
        <PortalParticipation />
      </IntlProvider>
    )

    const disclosure = container.querySelector('details.portal-participation-disclosure')
    expect(disclosure).not.toBeNull()
    expect(disclosure?.querySelector('summary')).toHaveTextContent('How participation works')
    expect(disclosure?.hasAttribute('open')).toBe(false)
    expect(container.querySelector('dl.portal-participation--wide')).not.toBeNull()
    expect(screen.getAllByText('The team manages progress')).toHaveLength(2)
  })
})
