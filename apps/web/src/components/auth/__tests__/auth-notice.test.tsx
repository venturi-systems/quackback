// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AuthNotice, authNoticeMessage } from '../auth-notice'
import { AUTH_BLOCK_MESSAGES } from '@/lib/server/auth/redirect-errors'

describe('AuthNotice', () => {
  it('maps a known redirect code to its durable message', () => {
    expect(authNoticeMessage('not_team_member')).toBe(AUTH_BLOCK_MESSAGES.not_team_member)
  })

  it('renders nothing for a missing or unknown code', () => {
    expect(authNoticeMessage(undefined)).toBeNull()
    expect(authNoticeMessage('<script>')).toBeNull()
    const { container } = render(<AuthNotice code="made_up" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps the message on the page as ordinary content, not a live region', () => {
    render(<AuthNotice code="not_team_member" />)
    const notice = screen.getByTestId('auth-notice')
    expect(notice).toHaveTextContent(AUTH_BLOCK_MESSAGES.not_team_member)
    expect(notice.getAttribute('role')).toBeNull()
    expect(notice.getAttribute('aria-live')).toBeNull()
  })
})
