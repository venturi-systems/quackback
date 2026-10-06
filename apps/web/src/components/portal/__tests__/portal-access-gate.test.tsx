// @vitest-environment happy-dom
import { render, screen, act } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'

const navigate = vi.fn()
const invalidate = vi.fn().mockResolvedValue(undefined)
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ navigate, invalidate }),
}))

// Capture only GateCard's broadcast onSuccess (no `enabled` prop).
let broadcastOnSuccess: (() => void) | undefined
vi.mock('@/lib/client/hooks/use-auth-broadcast', () => ({
  useAuthBroadcast: (opts: { onSuccess?: () => void; enabled?: boolean }) => {
    if (!('enabled' in opts)) broadcastOnSuccess = opts.onSuccess
  },
  postAuthSuccess: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

// Resolves: unmounting the gate mid-2FA revokes the session with
// `void signOut().catch(...)`, which the later-step tests exercise.
vi.mock('@/lib/client/auth-client', () => ({ signOut: vi.fn().mockResolvedValue(undefined) }))

// Capture the props the gate hands the inline form (mode etc.).
let formProps: Record<string, unknown> = {}
vi.mock('@/components/auth/portal-auth-form-inline', () => ({
  PortalAuthFormInline: (props: Record<string, unknown>) => {
    formProps = props
    return <div data-testid="auth-form-body">FORM_BODY</div>
  },
}))

vi.mock('@/lib/client/post-auth-navigation', () => ({ navigateAfterAuth: vi.fn() }))

import { PortalAccessGate } from '../portal-access-gate'
import { navigateAfterAuth } from '@/lib/client/post-auth-navigation'
import { SIGN_IN_FAILED_MESSAGE } from '@/lib/server/auth/redirect-errors'

const baseProps = {
  reason: 'unauthenticated' as const,
  workspaceName: 'Acme',
  logoUrl: null,
  authConfig: { found: true, oauth: { password: true }, oidcProviders: undefined },
  themeStyles: '',
  customCss: '',
  userEmail: null,
  locale: 'en' as const,
}

beforeEach(() => {
  navigate.mockClear()
  invalidate.mockClear()
  vi.mocked(navigateAfterAuth).mockClear()
  broadcastOnSuccess = undefined
  formProps = {}
})

describe('PortalAccessGate — inline auth form', () => {
  it('renders the auth form directly for an unauthenticated visitor, with no intermediate button', () => {
    render(<PortalAccessGate {...baseProps} />)
    expect(screen.getByTestId('auth-form-body')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /sign in \/ register/i })).not.toBeInTheDocument()
  })

  it('does NOT render the auth form for an unauthorized visitor', () => {
    render(<PortalAccessGate {...baseProps} reason="unauthorized" userEmail="alice@example.com" />)
    expect(screen.queryByTestId('auth-form-body')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })

  it('uses the standard Venturi footer and branded providers before authentication', () => {
    const { container, rerender } = render(<PortalAccessGate {...baseProps} />)
    expect(container.querySelector('.portal-gate--entry')).toBeInTheDocument()
    expect(screen.getByTestId('venturi-site-footer')).toBeInTheDocument()
    expect(screen.queryByTestId('venturi-landing-footer')).not.toBeInTheDocument()
    expect(formProps.providerAppearance).toBe('brand')
    expect(screen.getByRole('link', { name: 'Legal' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Legal' })).toHaveAttribute(
      'href',
      'https://venturi.systems/legal/'
    )
    expect(screen.queryByRole('link', { name: 'Source code (AGPL-3.0)' })).not.toBeInTheDocument()
    rerender(<PortalAccessGate {...baseProps} reason="unauthorized" />)
    expect(container.querySelector('.portal-gate--entry')).not.toBeInTheDocument()
    expect(screen.queryByTestId('venturi-landing-footer')).not.toBeInTheDocument()
    expect(screen.getByTestId('venturi-site-footer')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Legal' })).toHaveAttribute(
      'href',
      'https://venturi.systems/legal/'
    )
  })

  it('seeds the form mode from autoOpenSignin', () => {
    render(<PortalAccessGate {...baseProps} autoOpenSignin="signup" />)
    expect(formProps.mode).toBe('signup')
  })

  it('defaults the form mode to login when autoOpenSignin is absent', () => {
    render(<PortalAccessGate {...baseProps} />)
    expect(formProps.mode).toBe('login')
  })
})

describe('PortalAccessGate — content privacy', () => {
  it('does not render a real or simulated board before authentication', () => {
    render(<PortalAccessGate {...baseProps} />)
    expect(screen.queryByTestId('portal-gate-backdrop')).not.toBeInTheDocument()
    expect(screen.queryByText('Roadmap')).not.toBeInTheDocument()
    expect(screen.queryByText('Dark mode for the dashboard')).not.toBeInTheDocument()
  })
})

describe('PortalAccessGate — feedback entry', () => {
  it('is a full public page with the company header, main landmark and footer', () => {
    render(<PortalAccessGate {...baseProps} visibility="private" />)
    expect(screen.getAllByRole('link', { name: 'Venturi home' })).toHaveLength(2)
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Legal and sitemap' })).toBeInTheDocument()
  })

  it('explains collaboration and approval without exposing help intended for admitted users', () => {
    render(<PortalAccessGate {...baseProps} visibility="private" />)
    expect(screen.getByTestId('portal-gate-access')).toHaveTextContent(
      'Sign in with an approved account to share ideas, discuss improvements, and follow progress.'
    )
    expect(
      screen.getByRole('heading', { level: 1, name: 'Share feedback with Acme' })
    ).toBeVisible()
    expect(
      screen.queryByText('Anyone who signs in can read and take part.')
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Who can do what')).not.toBeInTheDocument()
    expect(screen.queryByText('Feedback FAQ')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Sign in' })).toContainElement(
      screen.getByTestId('auth-form-body')
    )
  })

  it.each(['email', 'two-factor-enroll', 'two-factor-challenge'])(
    'retains approved-account guidance during the %s step',
    (step) => {
      const { container } = render(<PortalAccessGate {...baseProps} visibility="private" />)
      const onContextChange = formProps.onContextChange as (ctx: {
        step: string
        email: string
      }) => void
      act(() => onContextChange({ step, email: 'alex@acme.example' }))
      expect(container.querySelector('.portal-gate__intro')).toHaveTextContent(
        'Sign in with an approved account'
      )
      expect(container).not.toHaveTextContent('Who can do what')
    }
  )

  it('retains the email-code step and its destination address', () => {
    render(<PortalAccessGate {...baseProps} visibility="private" />)
    const onContextChange = formProps.onContextChange as (ctx: {
      step: string
      email: string
    }) => void
    act(() => onContextChange({ step: 'code', email: 'alex@acme.example' }))
    expect(screen.getByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(screen.getByText('alex@acme.example')).toBeInTheDocument()
  })
})

describe('PortalAccessGate — callbackUrl', () => {
  it('navigates to callbackUrl after a successful sign-in', async () => {
    render(<PortalAccessGate {...baseProps} callbackUrl="/admin" />)
    await act(async () => {
      broadcastOnSuccess?.()
      await Promise.resolve()
    })
    // navigateAfterAuth is called — not router.navigate directly.
    expect(vi.mocked(navigateAfterAuth)).toHaveBeenCalledWith('/admin', expect.any(Function))
    expect(navigate).not.toHaveBeenCalled()

    // Invoke the clientNavigate callback to cover the portal-local branch.
    const clientNavigate = vi.mocked(navigateAfterAuth).mock.calls[0][1]
    await act(async () => {
      clientNavigate()
      await Promise.resolve()
    })
    expect(invalidate).toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith({ to: '/admin' })
  })

  it('does not navigate when no callbackUrl is given', async () => {
    render(<PortalAccessGate {...baseProps} />)
    await act(async () => {
      broadcastOnSuccess?.()
      await Promise.resolve()
    })
    expect(invalidate).toHaveBeenCalled()
    expect(vi.mocked(navigateAfterAuth)).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })
})

// DEF-47: a refused sign-in lands on the gate as ?error=<code>, and the
// anonymous gate used to show the bare form with no reason.
describe('PortalAccessGate — refused sign-in notice', () => {
  it('explains a known sign-in error code on the anonymous gate', () => {
    render(<PortalAccessGate {...baseProps} visibility="authenticated" error="not_team_member" />)
    expect(screen.getByTestId('auth-notice')).toHaveTextContent(
      "This account doesn't have team access."
    )
    expect(screen.getByTestId('auth-form-body')).toBeInTheDocument()
  })

  it('explains it to a signed-in visitor without access too', () => {
    render(
      <PortalAccessGate
        {...baseProps}
        reason="unauthorized"
        userEmail="alice@example.com"
        error="team_identity_required"
      />
    )
    expect(screen.getByTestId('auth-notice')).toHaveTextContent(
      'Team access needs a verified team email address'
    )
  })

  // DEF-47 residual: a cancelled consent (access_denied) or a lost OAuth
  // state (state_mismatch) has no message of its own and used to leave the
  // gate unexplained. Any such code shows the generic failure, never itself.
  it.each([
    'access_denied',
    'state_mismatch',
    '123',
    'bogus',
    '__proto__',
    'constructor',
    'toString',
    '<script>',
  ])('shows the generic sign-in failure for the unknown code %j', (error) => {
    render(<PortalAccessGate {...baseProps} error={error} />)
    const notice = screen.getByTestId('auth-notice')
    expect(notice).toHaveTextContent(SIGN_IN_FAILED_MESSAGE)
    expect(notice.textContent).not.toContain(error)
    expect(screen.getByTestId('auth-form-body')).toBeInTheDocument()
  })

  it('shows nothing when there is no code', () => {
    render(<PortalAccessGate {...baseProps} />)
    expect(screen.queryByTestId('auth-notice')).not.toBeInTheDocument()
  })
})
