// @vitest-environment happy-dom
/**
 * Admin > Team designation panel (landing-page#2309): states the rule the
 * server enforces and lets an administrator designate an account that
 * already satisfies it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const hoisted = vi.hoisted(() => ({ designate: vi.fn() }))

vi.mock('@/lib/server/functions/admin', () => ({
  designateTeamMemberFn: (args: unknown) => hoisted.designate(args),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { TeamDesignationPanel } = await import('../team-designation-panel')

function wrap(node: ReactNode) {
  const client = new QueryClient()
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

const policy = { domains: ['venturi.systems'], providers: ['Google', 'GitHub'] }
const candidate = { principalId: 'principal_ops', name: 'Ops Person', email: 'ops@venturi.systems' }

beforeEach(() => {
  hoisted.designate.mockReset()
  hoisted.designate.mockResolvedValue({ principalId: 'principal_ops', role: 'member' })
})

describe('TeamDesignationPanel', () => {
  it('states the rule with the configured domain and providers', () => {
    wrap(<TeamDesignationPanel policy={policy} candidates={[]} isCurrentUserAdmin={false} />)
    expect(screen.getByRole('heading', { name: 'Who can hold a team role' })).toBeTruthy()
    expect(screen.getByTestId('team-designation-panel').textContent).toContain(
      'verified @venturi.systems address from a Google or GitHub account'
    )
  })

  it('offers designation only to an administrator', () => {
    wrap(
      <TeamDesignationPanel policy={policy} candidates={[candidate]} isCurrentUserAdmin={false} />
    )
    expect(screen.queryByText('Ops Person')).toBeNull()
  })

  it('designates a candidate after confirmation', async () => {
    wrap(<TeamDesignationPanel policy={policy} candidates={[candidate]} isCurrentUserAdmin />)
    fireEvent.click(screen.getByRole('button', { name: /make team member/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Designate' }))
    await waitFor(() =>
      expect(hoisted.designate).toHaveBeenCalledWith({
        data: { principalId: 'principal_ops', role: 'member' },
      })
    )
  })

  it('says so when no account is ready', () => {
    wrap(<TeamDesignationPanel policy={policy} candidates={[]} isCurrentUserAdmin />)
    expect(screen.getByText(/No contributor with a verified @venturi.systems/)).toBeTruthy()
  })
})
