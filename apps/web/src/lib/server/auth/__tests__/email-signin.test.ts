import { describe, it, expect, vi, beforeEach } from 'vitest'

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
