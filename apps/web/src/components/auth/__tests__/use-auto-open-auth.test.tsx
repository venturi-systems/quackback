// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const hoisted = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: hoisted.toastError } }))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: vi.fn() }) }))
vi.mock('@/components/auth/auth-popover-context', () => ({ useAuthPopoverSafe: () => null }))
vi.mock('@/lib/client/post-auth-navigation', () => ({ navigateAfterAuth: vi.fn() }))

import { useAutoOpenAuthDialog } from '../use-auto-open-auth'
import { AUTH_BLOCK_MESSAGES } from '@/lib/server/auth/redirect-errors'

const FALLBACK = 'Sign-in failed. Try again or contact your administrator if the problem persists.'

beforeEach(() => {
  hoisted.toastError.mockReset()
})

describe('useAutoOpenAuthDialog error toast', () => {
  it('shows the known message for a known code', () => {
    renderHook(() => useAutoOpenAuthDialog({ error: 'not_team_member', isAuthenticated: false }))
    expect(hoisted.toastError).toHaveBeenCalledWith(AUTH_BLOCK_MESSAGES.not_team_member)
  })

  it.each(['__proto__', 'constructor', 'toString', 'unknown_code'])(
    'always toasts a string (the generic fallback) for ?error=%s',
    (code) => {
      renderHook(() => useAutoOpenAuthDialog({ error: code, isAuthenticated: false }))
      expect(hoisted.toastError).toHaveBeenCalledTimes(1)
      expect(hoisted.toastError).toHaveBeenCalledWith(FALLBACK)
    }
  )
})
