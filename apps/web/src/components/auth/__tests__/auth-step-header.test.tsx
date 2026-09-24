// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { headerForStep } from '../auth-step-header'
import type { AuthFormStep } from '../email-signin-types'

// DEF-06: on the portal sign-in gate, the steps that fall back to the base-step
// copy (the email step and both 2FA steps) called every gated portal private.
// A portal whose visibility is `authenticated` is open to anyone who signs in,
// which is what the gate's own lead says, so those steps must say it too.

afterEach(cleanup)

/** The base step and every step that falls back to its copy. */
const BASE_STEPS: AuthFormStep[] = [
  'credentials',
  'email',
  'two-factor-enroll',
  'two-factor-challenge',
]

function gateDescription(
  step: AuthFormStep,
  mode: 'login' | 'signup',
  visibility?: 'public' | 'authenticated' | 'private'
): string {
  const { description } = headerForStep(
    mode,
    { step, email: 'ann@example.com' },
    { surface: 'private-portal', workspaceName: 'Acme', visibility }
  )
  const { container } = render(<IntlProvider locale="en">{description}</IntlProvider>)
  return container.textContent ?? ''
}

describe('portal gate step copy', () => {
  for (const step of BASE_STEPS) {
    for (const mode of ['login', 'signup'] as const) {
      it(`${step} (${mode}) does not call an authenticated portal private`, () => {
        const text = gateDescription(step, mode, 'authenticated')
        expect(text).not.toMatch(/private/i)
        expect(text).toContain('Anyone who signs in can read and take part.')
      })

      it(`${step} (${mode}) keeps the private copy for a private portal`, () => {
        expect(gateDescription(step, mode, 'private')).toContain('This portal is private.')
        expect(gateDescription(step, mode)).toContain('This portal is private.')
      })
    }
  }

  it('leaves the step-specific copy alone', () => {
    expect(gateDescription('code', 'login', 'authenticated')).toContain('ann@example.com')
    expect(gateDescription('forgot', 'login', 'authenticated')).toContain('reset link')
  })
})
