// @vitest-environment happy-dom
import type { ComponentType } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const state = vi.hoisted(() => ({ enabled: true, social: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useLoaderData: () => ({ ssoEnabled: state.enabled }),
  }),
  redirect: vi.fn(),
}))
vi.mock('@/lib/client/auth-client', () => ({
  authClient: { signIn: { social: state.social }, signUp: { email: vi.fn() } },
}))
vi.mock('@/lib/server/functions/admin', () => ({ getPublicAuthConfig: vi.fn() }))
vi.mock('@/lib/server/functions/onboarding', () => ({ checkOnboardingState: vi.fn() }))
const { Route } = await import('../_layout.account')
const AccountStep = Route.options.component as ComponentType

beforeEach(() => {
  state.enabled = true
  state.social.mockReset()
})
describe('onboarding SSO with the shared social API', () => {
  it('starts SSO on mount and lets the user retry a failed redirect', async () => {
    state.social
      .mockRejectedValueOnce(new Error('Provider unavailable'))
      .mockResolvedValueOnce({ data: {} })
    render(<AccountStep />)
    expect(await screen.findByText('Provider unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue with single sign-on' }))
    await waitFor(() => expect(state.social).toHaveBeenCalledTimes(2))
    for (const [request] of state.social.mock.calls)
      expect(request).toEqual({ provider: 'sso', callbackURL: '/' })
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('keeps manual account setup when SSO is not registered', () => {
    state.enabled = false
    render(<AccountStep />)
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(state.social).not.toHaveBeenCalled()
  })
})
