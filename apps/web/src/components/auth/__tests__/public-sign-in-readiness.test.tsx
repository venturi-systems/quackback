// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'
import { IntlProvider } from 'react-intl'
import { describe, expect, it } from 'vitest'
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

  it('keeps native recovery available and controls disabled without client scripts', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToString(element)
    expect(container.querySelector('fieldset')).toBeDisabled()
    expect(container.querySelector('button')).toBeDisabled()
    expect(container.querySelector('input')).toBeDisabled()
    expect(container.querySelector('[role="status"]')).toHaveTextContent('enable JavaScript')
    expect(container.querySelector('a[href=""]')).toHaveTextContent('Reload this page')
    expect(container.querySelector('a[href="https://venturi.systems/"]')).toHaveTextContent(
      'Venturi home'
    )
  })

  it('enables the same controls only after hydration and removes the recovery notice', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    container.innerHTML = renderToString(element)
    const button = container.querySelector('button')
    expect(button).toBeDisabled()
    let root: ReturnType<typeof hydrateRoot> | undefined
    try {
      await act(async () => {
        root = hydrateRoot(container, element)
      })
      expect(container.querySelector('button')).toBe(button)
      expect(button).toBeEnabled()
      expect(container.querySelector('input')).toBeEnabled()
      expect(container.querySelector('[role="status"]')).not.toBeInTheDocument()
    } finally {
      await act(async () => root?.unmount())
      container.remove()
    }
  })
})
