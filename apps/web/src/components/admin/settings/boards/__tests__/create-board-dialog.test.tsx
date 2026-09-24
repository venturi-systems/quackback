// @vitest-environment happy-dom
/**
 * <CreateBoardDialog> — preset-tile picker (Public / Private).
 *
 * Covers:
 *   - Default preset is Public.
 *   - Clicking Private flips aria-pressed (Private on, Public off).
 *   - Submit calls the mutation with { name, description, preset }.
 *   - "Customize after create" routes to the Access tab on success.
 *   - "Customize after create" stays opt-in (off by default routes plain).
 *   - When the deployment's policy owns the Anyone tier
 *     (POLICY_MANAGED_SETTINGS `boards.anonymousAccess`), Public is disabled
 *     and explained, and Private is the default.
 *
 * The mutation and navigation primitives are mocked so the test stays
 * focused on the modal's preset/customize wiring without spinning up a
 * query client or a router.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// ---- Mocks -----------------------------------------------------------

const mutate = vi.fn()
const reset = vi.fn()
vi.mock('@/lib/client/mutations', () => ({
  useCreateBoard: () => ({
    mutate,
    reset,
    isPending: false,
    isError: false,
    error: null,
  }),
}))

const navigate = vi.fn()
const invalidate = vi.fn()
// The root route context carries the deployment's managed paths.
const routeContext = { managedFieldPaths: [] as string[] }
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate }),
  useNavigate: () => navigate,
  useRouteContext: () => routeContext,
}))

import { CreateBoardDialog } from '../create-board-dialog'

beforeEach(() => {
  mutate.mockReset()
  reset.mockReset()
  navigate.mockReset()
  invalidate.mockReset()
  routeContext.managedFieldPaths = []
})

function renderModal() {
  return render(<CreateBoardDialog open={true} onOpenChange={() => {}} />)
}

function getPublicTile() {
  return screen.getByRole('button', { name: 'Public' })
}
function getPrivateTile() {
  return screen.getByRole('button', { name: 'Private' })
}
function getCustomizeCheckbox() {
  return screen.getByRole('checkbox', { name: 'Customize access after create' })
}

describe('<CreateBoardDialog> preset tiles', () => {
  it('renders Public as the default-active tile', () => {
    renderModal()
    expect(getPublicTile()).toHaveAttribute('aria-pressed', 'true')
    expect(getPrivateTile()).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking Private highlights Private and dehighlights Public', () => {
    renderModal()
    fireEvent.click(getPrivateTile())
    expect(getPrivateTile()).toHaveAttribute('aria-pressed', 'true')
    expect(getPublicTile()).toHaveAttribute('aria-pressed', 'false')
  })

  it('clicking back to Public re-highlights Public', () => {
    renderModal()
    fireEvent.click(getPrivateTile())
    fireEvent.click(getPublicTile())
    expect(getPublicTile()).toHaveAttribute('aria-pressed', 'true')
    expect(getPrivateTile()).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('<CreateBoardDialog> submit', () => {
  it('submits with preset: "public" by default', async () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('Board name'), {
      target: { value: 'Feature Requests' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }))
    })

    expect(mutate).toHaveBeenCalledTimes(1)
    const [payload] = mutate.mock.calls[0]!
    expect(payload).toMatchObject({ name: 'Feature Requests', preset: 'public' })
  })

  it('submits with preset: "private" when Private tile is selected', async () => {
    renderModal()

    fireEvent.change(screen.getByLabelText('Board name'), {
      target: { value: 'Internal Roadmap' },
    })
    fireEvent.click(getPrivateTile())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }))
    })

    expect(mutate).toHaveBeenCalledTimes(1)
    const [payload] = mutate.mock.calls[0]!
    expect(payload).toMatchObject({ name: 'Internal Roadmap', preset: 'private' })
  })

  it('navigates to the board (no tab) by default on success', async () => {
    renderModal()
    fireEvent.change(screen.getByLabelText('Board name'), {
      target: { value: 'Feedback' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }))
    })

    // Trigger the mutation's onSuccess callback with a synthetic created board.
    const opts = mutate.mock.calls[0]![1] as { onSuccess: (b: { slug: string }) => void }
    act(() => {
      opts.onSuccess({ slug: 'feedback' })
    })

    expect(navigate).toHaveBeenCalledWith({
      to: '/admin/settings/boards',
      search: { board: 'feedback' },
    })
  })

  it('routes to the Access tab when "Customize after create" is checked', async () => {
    renderModal()
    fireEvent.change(screen.getByLabelText('Board name'), {
      target: { value: 'Locked Board' },
    })
    fireEvent.click(getCustomizeCheckbox())
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }))
    })

    const opts = mutate.mock.calls[0]![1] as { onSuccess: (b: { slug: string }) => void }
    act(() => {
      opts.onSuccess({ slug: 'locked-board' })
    })

    expect(navigate).toHaveBeenCalledWith({
      to: '/admin/settings/boards',
      search: { board: 'locked-board', tab: 'access' },
    })
  })
})

describe('<CreateBoardDialog> policy-owned Anyone tier', () => {
  beforeEach(() => {
    routeContext.managedFieldPaths = ['portal.access.visibility', 'boards.anonymousAccess']
  })

  it('disables Public, explains why, and defaults to Private', () => {
    renderModal()
    expect(getPublicTile()).toBeDisabled()
    expect(getPublicTile()).toHaveAttribute('data-disabled-reason', 'policy')
    expect(getPublicTile()).toHaveTextContent('requires sign-in on every board')
    expect(getPrivateTile()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('anonymous-policy-note')).toHaveTextContent(
      'choose Signed-in on its Access tab'
    )
  })

  it('submits Private, never the refused Public preset', async () => {
    renderModal()
    fireEvent.click(getPublicTile())
    fireEvent.change(screen.getByLabelText('Board name'), {
      target: { value: 'Ideas' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create board' }))
    })
    expect(mutate).toHaveBeenCalledTimes(1)
    const [payload] = mutate.mock.calls[0]!
    expect(payload).toMatchObject({ name: 'Ideas', preset: 'private' })
  })

  it('keeps Public available when the policy owns only named boards', () => {
    routeContext.managedFieldPaths = ['boards.feature-requests.access']
    renderModal()
    expect(getPublicTile()).not.toBeDisabled()
    expect(getPublicTile()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTestId('anonymous-policy-note')).not.toBeInTheDocument()
  })
})
