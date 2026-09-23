// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import type { Role } from '@/lib/shared/roles'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))

import { FeedbackEmptyState } from '../feedback-empty-state'

afterEach(cleanup)

function show(authenticated: boolean, role?: Role | null, onSignIn?: () => void) {
  return render(
    <IntlProvider locale="en">
      <FeedbackEmptyState authenticated={authenticated} role={role} onSignIn={onSignIn} />
    </IntlProvider>
  )
}

describe('empty feedback state reflects actual team permissions', () => {
  it.each(['user', null, undefined] as const)(
    'does not advertise admin actions to signed-in %s',
    (role) => {
      show(true, role)
      expect(screen.queryByRole('link', { name: 'Manage feedback' })).toBeNull()
      expect(screen.queryByRole('link', { name: 'Configure boards' })).toBeNull()
      expect(screen.getByRole('link', { name: 'View roadmap' }).getAttribute('href')).toBe(
        '/roadmap'
      )
      expect(screen.getByText(/No feedback boards are available to your account/)).toBeTruthy()
    }
  )

  it('offers board settings only to an authenticated administrator', () => {
    show(true, 'admin')
    expect(screen.getByRole('link', { name: 'Configure boards' }).getAttribute('href')).toBe(
      '/admin/settings/boards'
    )
    expect(screen.getByRole('link', { name: 'Manage feedback' })).toBeTruthy()
  })

  it('lets team moderators manage feedback without advertising administrator settings', () => {
    show(true, 'member')
    expect(screen.getByRole('link', { name: 'Manage feedback' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Configure boards' })).toBeNull()
  })

  it('does not trust a stale team role after sign-out and opens the supplied sign-in flow', () => {
    const signIn = vi.fn()
    show(false, 'admin', signIn)
    expect(screen.queryByRole('link', { name: 'Manage feedback' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('does not render an inert login button when sign-in is unavailable', () => {
    show(false)
    expect(screen.queryByRole('button', { name: 'Log in' })).toBeNull()
    expect(screen.getByRole('link', { name: 'View roadmap' })).toBeTruthy()
  })
})
