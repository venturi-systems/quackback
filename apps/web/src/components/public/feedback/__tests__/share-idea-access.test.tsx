// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routeContext = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}))
const openAuthPopover = vi.hoisted(() => vi.fn())
const oauth2 = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useRouteContext: () => routeContext.value,
}))
vi.mock('@/components/auth/auth-popover-context', () => ({
  useAuthPopoverSafe: () => ({ openAuthPopover }),
}))
vi.mock('@/lib/client/auth-client', () => ({
  authClient: { signIn: { oauth2: (...args: unknown[]) => oauth2(...args) } },
}))
// The composer itself is lazy and framer-motion based; these tests cover the
// decision in front of it, so a marker stands in for the composer.
vi.mock('../feedback-header-animated', () => ({
  FeedbackHeaderAnimated: () => <div data-testid="composer" />,
}))

import { FeedbackHeader } from '../feedback-header'

const boards = [
  { id: 'board_ideas', name: 'Ideas', slug: 'ideas' },
  { id: 'board_roadmap', name: 'Roadmap', slug: 'roadmap' },
]

function setContext({
  principalType,
  oauth = { password: false, google: true, github: true },
  registered = ['google', 'github'],
}: {
  principalType?: 'user' | 'anonymous'
  oauth?: Record<string, boolean>
  registered?: string[]
}) {
  routeContext.value = {
    session: principalType ? { user: { principalType } } : null,
    settings: { publicAuthConfig: { oauth }, publicPortalConfig: {} },
    registeredAuthProviders: registered,
  }
}

function renderHeader(permissions: Record<string, Record<string, boolean>>, scopeBoardId?: string) {
  return render(
    <IntlProvider locale="en" messages={{}}>
      <FeedbackHeader
        workspaceName="Acme"
        boards={boards}
        scopeBoardId={scopeBoardId}
        boardPermissions={permissions as Record<string, { canSubmit: boolean; canVote: boolean }>}
      />
    </IntlProvider>
  )
}

describe('FeedbackHeader share-an-idea surface (E-8)', () => {
  beforeEach(() => {
    openAuthPopover.mockReset()
    oauth2.mockReset()
    window.history.replaceState(null, '', '/?board=ideas')
  })

  it('offers one sign-in action, not a dead composer, to a signed-out visitor', async () => {
    setContext({})
    renderHeader({
      board_ideas: { canSubmit: false, canVote: false, signedInCanSubmit: true },
      board_roadmap: { canSubmit: false, canVote: false, signedInCanSubmit: false },
    })

    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Sign in to share an idea' })
    fireEvent.click(button)

    expect(openAuthPopover).toHaveBeenCalledWith({
      mode: 'login',
      callbackUrl: '/?board=ideas#feedback-composer',
    })
    // The return point is marked in this tab for a dialog (no redirect) sign-in.
    expect(window.location.hash).toBe('#feedback-composer')
  })

  it('goes straight to the only OIDC provider when that is the sole sign-in method', () => {
    setContext({ oauth: { password: false }, registered: ['custom-oidc'] })
    renderHeader({
      board_ideas: { canSubmit: false, canVote: false, signedInCanSubmit: true },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to share an idea' }))
    expect(oauth2).toHaveBeenCalledWith({
      providerId: 'custom-oidc',
      callbackURL: '/?board=ideas#feedback-composer',
    })
    expect(openAuthPopover).not.toHaveBeenCalled()
  })

  it('does not promise sign-in when only groups or the team may post', () => {
    setContext({})
    renderHeader({
      board_ideas: { canSubmit: false, canVote: false, signedInCanSubmit: false },
      board_roadmap: { canSubmit: false, canVote: false, signedInCanSubmit: false },
    })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(
      screen.getByText('Posting ideas on these boards is limited to specific groups or the team.')
    ).toBeInTheDocument()
  })

  it('tells a signed-in viewer without submit access why there is no form', () => {
    setContext({ principalType: 'user' })
    renderHeader({
      board_ideas: { canSubmit: false, canVote: true, signedInCanSubmit: false },
    })
    expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
    expect(
      screen.getByText('Your account can read these boards but cannot post ideas on them.')
    ).toBeInTheDocument()
  })

  it('shows the composer when the viewer can post on any board', async () => {
    setContext({ principalType: 'user' })
    renderHeader({
      board_ideas: { canSubmit: false, canVote: true, signedInCanSubmit: false },
      board_roadmap: { canSubmit: true, canVote: true, signedInCanSubmit: true },
    })
    expect(await screen.findByTestId('composer')).toBeInTheDocument()
  })

  it('treats an anonymous session like a signed-out visitor', () => {
    setContext({ principalType: 'anonymous' })
    renderHeader({
      board_ideas: { canSubmit: false, canVote: false, signedInCanSubmit: true },
    })
    expect(screen.getByRole('button', { name: 'Sign in to share an idea' })).toBeInTheDocument()
  })

  it('says sign-in is unavailable when the portal has no sign-in method', () => {
    setContext({ oauth: { password: false }, registered: [] })
    renderHeader({
      board_ideas: { canSubmit: false, canVote: false, signedInCanSubmit: true },
    })
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(
      screen.getByText('Posting an idea needs an account, and sign-in is not available here.')
    ).toBeInTheDocument()
  })

  describe("on one board's feed", () => {
    const mixed = {
      board_ideas: { canSubmit: false, canVote: false, signedInCanSubmit: true },
      board_roadmap: { canSubmit: true, canVote: true, signedInCanSubmit: true },
    }

    it('asks a signed-out visitor to sign in when this board needs it, even if another board is open', () => {
      setContext({})
      renderHeader(mixed, 'board_ideas')
      expect(screen.queryByTestId('composer')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sign in to share an idea' })).toBeInTheDocument()
    })

    it('shows the composer when the visitor can post on this board', async () => {
      setContext({})
      renderHeader(mixed, 'board_roadmap')
      expect(await screen.findByTestId('composer')).toBeInTheDocument()
    })

    it('speaks about this board when a signed-in viewer cannot post on it', () => {
      setContext({ principalType: 'user' })
      renderHeader(
        {
          board_ideas: { canSubmit: false, canVote: true, signedInCanSubmit: false },
          board_roadmap: { canSubmit: true, canVote: true, signedInCanSubmit: true },
        },
        'board_ideas'
      )
      expect(
        screen.getByText('Your account can read this board but cannot post ideas on it.')
      ).toBeInTheDocument()
    })

    it('ignores a scope that is not one of the listed boards', async () => {
      setContext({ principalType: 'user' })
      renderHeader(mixed, 'board_unknown')
      expect(await screen.findByTestId('composer')).toBeInTheDocument()
    })
  })
})
