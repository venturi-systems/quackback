// @vitest-environment happy-dom
/**
 * Inline email capture is an UNVERIFIED identify.
 *
 * The visitor types the address, so the widget must send it through the
 * identify route's unverified path (`{ id, email, name }`), where the route
 * refuses addresses bound to a team account, never trusts `sub`, and records
 * hmacVerified=false. It must never obtain a server-signed ssoToken for a
 * typed address: the route treats an ssoToken as host-verified and exempts it
 * from the team-address guard, so a signed token for an administrator's
 * address would be an account takeover.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { installInMemoryLocalStorage } from '@/test/local-storage'
import { clearWidgetToken, setWidgetToken, getWidgetToken } from '@/lib/client/widget-auth'

installInMemoryLocalStorage()

vi.mock('@/lib/client/widget-bridge', () => ({ sendToHost: vi.fn() }))
vi.mock('@/lib/client/auth-client', () => ({
  authClient: { signIn: { anonymous: vi.fn().mockResolvedValue({ data: null, error: null }) } },
}))
vi.mock('@/lib/shared/i18n', async (orig) => ({
  ...(await orig<typeof import('@/lib/shared/i18n')>()),
  loadMessages: vi.fn().mockResolvedValue({}),
}))

import { WidgetAuthProvider, useWidgetAuth } from '../widget-auth-provider'

type IdentifyWithEmail = (email: string, name?: string) => Promise<boolean>

function renderWidget(props: { hmacRequired?: boolean } = {}) {
  const holder: { identifyWithEmail: IdentifyWithEmail | null } = { identifyWithEmail: null }
  function Probe() {
    holder.identifyWithEmail = useWidgetAuth().identifyWithEmail
    return null
  }
  const qc = new QueryClient()
  render(
    <QueryClientProvider client={qc}>
      <WidgetAuthProvider portalSessionToken={null} hmacRequired={props.hmacRequired}>
        <Probe />
      </WidgetAuthProvider>
    </QueryClientProvider>
  )
  return holder
}

const identifyResponse = {
  ok: true,
  json: async () => ({
    sessionToken: 'identified-token',
    user: { id: 'user_1', name: 'Ada', email: 'ada@acme.example', avatarUrl: null },
    votedPostIds: [],
  }),
}

function identifyCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/widget/identify')
}

describe('WidgetAuthProvider inline email capture', () => {
  beforeEach(() => {
    clearWidgetToken()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('posts an unverified identity body, never an ssoToken', async () => {
    const fetchMock = vi.fn().mockResolvedValue(identifyResponse)
    vi.stubGlobal('fetch', fetchMock)
    const holder = renderWidget()
    await waitFor(() => expect(holder.identifyWithEmail).not.toBeNull())

    await expect(holder.identifyWithEmail!('ada@acme.example', 'Ada')).resolves.toBe(true)

    const calls = identifyCalls(fetchMock)
    expect(calls).toHaveLength(1)
    const [, init] = calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ id: 'ada@acme.example', email: 'ada@acme.example', name: 'Ada' })
    expect(body).not.toHaveProperty('ssoToken')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(getWidgetToken()).toBe('identified-token')
  })

  it('defaults the name to the address local part', async () => {
    const fetchMock = vi.fn().mockResolvedValue(identifyResponse)
    vi.stubGlobal('fetch', fetchMock)
    const holder = renderWidget()
    await waitFor(() => expect(holder.identifyWithEmail).not.toBeNull())

    await holder.identifyWithEmail!('ada@acme.example')

    const [, init] = identifyCalls(fetchMock)[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body)).name).toBe('ada')
  })

  it('carries the previous anonymous token as body field and Bearer for the merge', async () => {
    setWidgetToken('anon-previous')
    const fetchMock = vi.fn().mockResolvedValue(identifyResponse)
    vi.stubGlobal('fetch', fetchMock)
    const holder = renderWidget()
    await waitFor(() => expect(holder.identifyWithEmail).not.toBeNull())

    await holder.identifyWithEmail!('ada@acme.example', 'Ada')

    const [, init] = identifyCalls(fetchMock)[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      id: 'ada@acme.example',
      email: 'ada@acme.example',
      name: 'Ada',
      previousToken: 'anon-previous',
    })
    expect(body).not.toHaveProperty('ssoToken')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer anon-previous',
    })
  })

  it('reports failure when the route refuses the address (for example a team account)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const holder = renderWidget()
    await waitFor(() => expect(holder.identifyWithEmail).not.toBeNull())

    await expect(holder.identifyWithEmail!('admin@acme.example')).resolves.toBe(false)
    expect(getWidgetToken()).toBeNull()
  })

  it('does not attempt inline capture when verified identity is required', async () => {
    const fetchMock = vi.fn().mockResolvedValue(identifyResponse)
    vi.stubGlobal('fetch', fetchMock)
    const holder = renderWidget({ hmacRequired: true })
    await waitFor(() => expect(holder.identifyWithEmail).not.toBeNull())

    await expect(holder.identifyWithEmail!('ada@acme.example')).resolves.toBe(false)
    expect(identifyCalls(fetchMock)).toHaveLength(0)
  })
})
