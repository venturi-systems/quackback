// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FormError } from '../form-error'

describe('FormError', () => {
  it('announces an actionable error and exposes a stable description id', () => {
    render(<FormError id="account-error" message="Sign-in failed" />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('id', 'account-error')
    expect(alert).toHaveAttribute('aria-live', 'assertive')
    expect(alert).toHaveTextContent('Sign-in failed')
  })
})
