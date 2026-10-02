// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IntlProvider } from 'react-intl'

const { routeContext, openAuthPopover, notifications, markRead, markAllRead } = vi.hoisted(() => ({
  routeContext: vi.fn(),
  openAuthPopover: vi.fn(),
  notifications: vi.fn(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => options,
  useRouteContext: () => routeContext(),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock('@/components/auth/auth-popover-context', () => ({
  useAuthPopoverSafe: () => ({ openAuthPopover }),
}))
vi.mock('@/lib/client/hooks/use-notifications-queries', () => ({
  useNotifications: () => notifications(),
}))
vi.mock('@/lib/client/mutations', () => ({
  useMarkNotificationAsRead: () => ({ mutate: markRead, isPending: false }),
  useMarkAllNotificationsAsRead: () => ({ mutate: markAllRead, isPending: false }),
}))
import { NotificationsPage } from '../notifications'

function page() {
  return (
    <IntlProvider locale="en" defaultLocale="en">
      <NotificationsPage />
    </IntlProvider>
  )
}

describe('FB-04 personal notification access presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notifications.mockReturnValue({ data: { notifications: [], unreadCount: 0 }, isLoading: false })
  })
  afterEach(cleanup)

  for (const session of [null, { user: { principalType: 'anonymous' } }]) {
    it(`offers sign-in and avoids personal queries for ${session ? 'anonymous' : 'absent'} sessions`, () => {
      routeContext.mockReturnValue({ session })
      render(page())
      expect(
        screen.getByRole('heading', { name: 'Sign in to view your notifications', level: 1 })
      ).toBeVisible()
      expect(screen.queryByText('All caught up!')).not.toBeInTheDocument()
      expect(notifications).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }))
      expect(openAuthPopover).toHaveBeenCalledWith({ mode: 'login', callbackUrl: '/notifications' })
      expect(markRead).not.toHaveBeenCalled()
      expect(markAllRead).not.toHaveBeenCalled()
    })
  }

  it('preserves the signed-in notification view and removes it when the session clears', () => {
    routeContext.mockReturnValue({ session: { user: { principalType: 'user' } } })
    const view = render(page())
    expect(screen.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible()
    expect(screen.getByText('All caught up!')).toBeVisible()
    expect(notifications).toHaveBeenCalled()
    expect(screen.queryByText('Sign in to view your notifications')).not.toBeInTheDocument()

    notifications.mockClear()
    routeContext.mockReturnValue({ session: null })
    view.rerender(page())
    expect(
      screen.getByRole('heading', { name: 'Sign in to view your notifications', level: 1 })
    ).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Notifications', level: 1 })
    ).not.toBeInTheDocument()
    expect(notifications).not.toHaveBeenCalled()
  })
})
