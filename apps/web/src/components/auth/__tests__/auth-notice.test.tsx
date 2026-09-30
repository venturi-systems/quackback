// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuthNotice, authNoticeMessage } from '../auth-notice'
import { AUTH_BLOCK_MESSAGES, SIGN_IN_FAILED_MESSAGE } from '@/lib/server/auth/redirect-errors'

describe('AuthNotice', () => {
  it('maps a known redirect code to its durable message', () => {
    expect(authNoticeMessage('not_team_member')).toBe(AUTH_BLOCK_MESSAGES.not_team_member)
  })

  it('renders nothing when there is no code', () => {
    expect(authNoticeMessage(undefined)).toBeNull()
    expect(authNoticeMessage(null)).toBeNull()
    expect(authNoticeMessage('')).toBeNull()
    expect(authNoticeMessage('   ')).toBeNull()
    const { container } = render(<AuthNotice code="" />)
    expect(container).toBeEmptyDOMElement()
  })

  // DEF-47 residual: a cancelled Google or GitHub consent lands on
  // /?error=access_denied and a lost OAuth state on /?error=state_mismatch.
  // Neither has a message of its own, and the page used to say nothing.
  it.each(['access_denied', 'state_mismatch', 'made_up', '<script>'])(
    'explains the unknown code %j with the generic sign-in failure, never the code',
    (code) => {
      expect(authNoticeMessage(code)).toBe(SIGN_IN_FAILED_MESSAGE)
      render(<AuthNotice code={code} />)
      const notice = screen.getByTestId('auth-notice')
      expect(notice).toHaveTextContent(SIGN_IN_FAILED_MESSAGE)
      expect(notice.textContent).not.toContain(code)
    }
  )

  it('keeps the message on the page as ordinary content, not a live region', () => {
    render(<AuthNotice code="not_team_member" />)
    const notice = screen.getByTestId('auth-notice')
    expect(notice).toHaveTextContent(AUTH_BLOCK_MESSAGES.not_team_member)
    expect(notice.getAttribute('role')).toBeNull()
    expect(notice.getAttribute('aria-live')).toBeNull()
  })
})

describe('AuthNotice with prototype-key codes from the URL', () => {
  it.each(['__proto__', 'constructor', 'toString', 'unknown_code'])(
    'shows only the generic text for ?error=%s',
    (code) => {
      // Before the own-key guard, __proto__ resolved to Object.prototype and
      // rendering it threw "Objects are not valid as a React child".
      expect(authNoticeMessage(code)).toBe(SIGN_IN_FAILED_MESSAGE)
      render(<AuthNotice code={code} />)
      expect(screen.getByTestId('auth-notice')).toHaveTextContent(SIGN_IN_FAILED_MESSAGE)
    }
  )
})
