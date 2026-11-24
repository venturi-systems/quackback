import { describe, it, expect, vi, beforeEach } from 'vitest'
import { APIError } from 'better-auth/api'
import { AUTH_BLOCK_MESSAGES } from '../redirect-errors'

const hoisted = vi.hoisted(() => ({
  mockMintMagicLinkUrl: vi.fn(async () => ({
    url: 'https://example.com/verify-magic-link?token=t',
    token: 't',
  })),
  mockSendVerificationOTP: vi.fn(async () => undefined),
  mockSendMagicLinkEmail: vi.fn(async () => undefined),
  mockGetOTP: vi.fn(() => '123456'),
}))

vi.mock('../magic-link-mint', () => ({ mintMagicLinkUrl: hoisted.mockMintMagicLinkUrl }))

vi.mock('../index', () => ({
  getAuth: vi.fn(async () => ({
    api: { sendVerificationOTP: hoisted.mockSendVerificationOTP },
  })),
  getOTP: hoisted.mockGetOTP,
}))

vi.mock('@/lib/server/db', () => ({
  db: { query: { settings: { findFirst: vi.fn(async () => null) } } },
}))

vi.mock('@quackback/email', () => ({
  isEmailConfigured: () => true,
  sendMagicLinkEmail: hoisted.mockSendMagicLinkEmail,
}))

vi.mock('@/lib/server/storage/s3', () => ({ getEmailSafeUrl: () => null }))

vi.mock('@/lib/server/config', () => ({ config: { baseUrl: 'https://acme.quackback.io' } }))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}))

import { Route } from '@/routes/api/auth/portal-signin'
import { requestEmailSignin } from '../email-signin'

describe('requestEmailSignin — failed-verify redirect', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes admin callbacks to the unified login on failed verify', async () => {
    await requestEmailSignin({ email: 'jess@example.com', callbackURL: '/admin/feedback' })
    expect(hoisted.mockMintMagicLinkUrl).toHaveBeenCalledWith(
      expect.objectContaining({ errorCallbackPath: '/auth/login?callbackUrl=/admin' })
    )
  })

  it('routes portal callbacks to /auth/login on failed verify', async () => {
    await requestEmailSignin({ email: 'user@example.com', callbackURL: '/p/posts' })
    expect(hoisted.mockMintMagicLinkUrl).toHaveBeenCalledWith(
      expect.objectContaining({ errorCallbackPath: '/auth/login' })
    )
  })
})

describe('requestEmailSignin — refused send', () => {
  beforeEach(() => vi.clearAllMocks())

  it('mints no magic link and sends no email when the sign-in hooks refuse the OTP send', async () => {
    // e.g. magic link is off and the address is new: the per-method gate in
    // hooks.before refuses sendVerificationOTP. mintMagicLinkUrl bypasses the
    // hooks, so it must not run first and leave an undelivered token row.
    hoisted.mockSendVerificationOTP.mockRejectedValueOnce(
      new Error('magic_link_method_not_allowed')
    )

    await expect(
      requestEmailSignin({ email: 'newcomer@example.com', callbackURL: '/' })
    ).rejects.toThrow('magic_link_method_not_allowed')

    expect(hoisted.mockMintMagicLinkUrl).not.toHaveBeenCalled()
    expect(hoisted.mockSendMagicLinkEmail).not.toHaveBeenCalled()
  })
})

describe('POST /api/auth/portal-signin', () => {
  type Handler = (context: { request: Request }) => Promise<Response>
  const post = (Route as unknown as { options: { server: { handlers: { POST: Handler } } } })
    .options.server.handlers.POST
  const request = () =>
    post({
      request: new Request('https://acme.quackback.io/api/auth/portal-signin', {
        method: 'POST',
        body: JSON.stringify({ email: 'visitor@example.com', callbackURL: '/' }),
      }),
    })

  beforeEach(() => vi.clearAllMocks())

  it.each([
    '/?auth=signin&error=magic_link_method_not_allowed',
    '/?auth=signin&callbackUrl=/admin&error=magic_link_method_not_allowed',
  ])('reports the disabled method without issuing a sign-in link for %s', async (location) => {
    hoisted.mockSendVerificationOTP.mockRejectedValueOnce(
      new APIError('FOUND', undefined, { location })
    )
    const res = await request()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: AUTH_BLOCK_MESSAGES.magic_link_method_not_allowed })
    expect(res.headers.has('set-cookie')).toBe(false)
    expect(hoisted.mockMintMagicLinkUrl).not.toHaveBeenCalled()
    expect(hoisted.mockSendMagicLinkEmail).not.toHaveBeenCalled()
  })

  it('sends the sign-in email when the method is allowed', async () => {
    const res = await request()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(hoisted.mockMintMagicLinkUrl).toHaveBeenCalledOnce()
    expect(hoisted.mockSendMagicLinkEmail).toHaveBeenCalledOnce()
  })

  it('does not report an unrelated redirect as the workspace policy', async () => {
    hoisted.mockSendVerificationOTP.mockRejectedValueOnce(
      new APIError('FOUND', undefined, {
        location: 'https://elsewhere.example/?auth=signin&error=magic_link_method_not_allowed',
      })
    )
    expect((await request()).status).toBe(500)
  })

  it('keeps unexpected delivery failures distinct from policy denials', async () => {
    hoisted.mockSendMagicLinkEmail.mockRejectedValueOnce(new Error('delivery unavailable'))
    expect((await request()).status).toBe(500)
  })
})
