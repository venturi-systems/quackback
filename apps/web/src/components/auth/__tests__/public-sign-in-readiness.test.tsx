// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'
import { IntlProvider } from 'react-intl'
import { describe, expect, it, vi } from 'vitest'
import { PublicSignInReadiness } from '../public-sign-in-readiness'

const wrap = (children: ReactNode) => (
  <IntlProvider locale="en" messages={{}}>
    {children}
  </IntlProvider>
)

// FB-03: exercise actual server markup and hydration, not just a client render.
describe('FB-03 public sign-in recovery', () => {
  const element = wrap(
    <PublicSignInReadiness>
      <button type="button">Sign in with Google</button>
      <input aria-label="Email" />
    </PublicSignInReadiness>
  )

  it('explains disabled controls and keeps native recovery available without scripts', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    expect(container.querySelector('fieldset')).toBeDisabled()
    expect(container.querySelector('button')).toBeDisabled()
    expect(container.querySelector('input')).toBeDisabled()
    const help = container.querySelector('details')
    expect(help).not.toHaveAttribute('open')
    expect(help?.querySelector('summary [aria-hidden="false"]')).toHaveTextContent(
      'Sign-in needs JavaScript'
    )
    expect(help).toHaveTextContent('enable JavaScript')
    expect(help?.querySelector('a[href=""]')).toHaveTextContent('Reload this page')
    expect(help?.querySelector('a[href="https://venturi.systems/"]')).toHaveTextContent(
      'Venturi home'
    )
  })

  for (const expanded of [false, true]) {
    it(`preserves native help, focus and ${expanded ? 'expanded' : 'collapsed'} state through hydration`, async () => {
      const container = document.createElement('div')
      document.body.append(container)
      container.innerHTML = renderToString(element)
      const button = container.querySelector('button')
      const help = container.querySelector('details')!
      const summary = help.querySelector('summary')!
      help.open = expanded
      summary.focus()
      expect(button).toBeDisabled()
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      let root: ReturnType<typeof hydrateRoot> | undefined
      try {
        await act(async () => {
          root = hydrateRoot(container, element)
        })
        expect(container.querySelector('button')).toBe(button)
        expect(button).toBeEnabled()
        expect(container.querySelector('input')).toBeEnabled()
        expect(container.querySelector('details')).toBe(help)
        expect(help.open).toBe(expanded)
        expect(document.activeElement).toBe(summary)
        expect(summary.querySelector('[aria-hidden="false"]')).toHaveTextContent('Sign-in help')
        expect(help.querySelector('a[href=""]')).toHaveTextContent('Reload this page')
        expect(help).toHaveTextContent('enable JavaScript')
        expect(consoleError).not.toHaveBeenCalled()
      } finally {
        await act(async () => root?.unmount())
        container.remove()
        consoleError.mockRestore()
      }
    })
  }
})
