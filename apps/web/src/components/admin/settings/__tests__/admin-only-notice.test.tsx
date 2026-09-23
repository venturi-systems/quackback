// @vitest-environment happy-dom
/**
 * <AdminOnlyNotice> is the durable state a team member sees on an
 * administrator-only settings page (E-5). It must name the reason, the request
 * path, and what the member can still do, in short units that do not strand a
 * final word at any width (v6.6 short-copy rule).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { AdminOnlyNotice } from '../admin-only-notice'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}))

describe('AdminOnlyNotice', () => {
  it('names the reason and the request path', () => {
    render(<AdminOnlyNotice />)
    const notice = screen.getByRole('region', { name: 'Administrators only' })
    expect(
      within(notice).getByText(/Only administrators can change workspace settings/)
    ).toBeInTheDocument()
    expect(
      within(notice).getByText(
        'Ask an administrator in your workspace if something needs to change.'
      )
    ).toBeInTheDocument()
  })

  it('links the settings a team member can change, with 44px targets', () => {
    render(<AdminOnlyNotice />)
    for (const [name, href] of [
      ['Statuses', '/admin/settings/statuses'],
      ['Tags', '/admin/settings/tags'],
    ] as const) {
      const link = screen.getByRole('link', { name })
      expect(link).toHaveAttribute('href', href)
      expect(link.className).toContain('min-h-11')
    }
  })

  it('lists the sidebar tasks as short items rather than one long sentence', () => {
    render(<AdminOnlyNotice />)
    expect(screen.getByText('Also from the sidebar')).toBeInTheDocument()
    const lists = screen.getAllByRole('list')
    const sidebarTasks = within(lists[lists.length - 1])
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(sidebarTasks).toEqual([
      'Review feedback',
      'Set status',
      'Move roadmap items',
      'Moderate submissions',
    ])
  })
})
