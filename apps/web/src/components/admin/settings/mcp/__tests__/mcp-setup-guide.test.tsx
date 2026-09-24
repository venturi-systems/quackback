// @vitest-environment happy-dom
/**
 * The MCP setup guide must not recommend an OAuth config the server refuses.
 * Claude Code and Claude Desktop sign in with OAuth by registering a client
 * before any account exists, which this fork never allows (the server always
 * reports registration closed). With registration closed, the guide offers
 * API-key configs only and says why.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/admin/settings/developers">{children}</a>
  ),
}))

import { McpSetupGuide } from '../mcp-setup-guide'

const ENDPOINT = 'https://feedback.acme.example/api/mcp'

describe('McpSetupGuide', () => {
  it('offers API-key configs only when OAuth registration is closed', () => {
    const { container } = render(<McpSetupGuide endpointUrl={ENDPOINT} />)

    expect(screen.queryByRole('button', { name: /OAuth/ })).toBeNull()
    expect(screen.getByText(/OAuth sign-in for MCP clients is turned off/)).toBeTruthy()
    // Claude Code is the default client; its config must carry the API key header.
    expect(container.textContent).toContain('QUACKBACK_API_KEY')

    fireEvent.click(screen.getByRole('button', { name: /Claude Desktop/ }))
    expect(screen.queryByRole('button', { name: /OAuth/ })).toBeNull()
    expect(container.textContent).toContain('qb_YOUR_API_KEY')
  })

  it('keeps the OAuth option (default) when registration is open', () => {
    const { container } = render(<McpSetupGuide endpointUrl={ENDPOINT} oauthRegistrationOpen />)

    expect(screen.getByRole('button', { name: 'OAuth (recommended)' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'API Key' })).toBeTruthy()
    expect(screen.queryByText(/OAuth sign-in for MCP clients is turned off/)).toBeNull()
    expect(container.textContent).not.toContain('QUACKBACK_API_KEY')

    fireEvent.click(screen.getByRole('button', { name: 'API Key' }))
    expect(container.textContent).toContain('QUACKBACK_API_KEY')
  })
})
