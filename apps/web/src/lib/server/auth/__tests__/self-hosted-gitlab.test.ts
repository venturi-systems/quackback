import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { gitlab } from 'better-auth/social-providers'

// A self-hosted GitLab's code exchange, refresh and user lookup must go through
// `safeFetch`. Mock only `safeFetch`; keep `SsrfError` real.
vi.mock('@/lib/server/content/ssrf-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/server/content/ssrf-guard')>()
  return { ...actual, safeFetch: vi.fn() }
})

import { safeFetch, SsrfError } from '@/lib/server/content/ssrf-guard'
import {
  gitlabEndpoints,
  pinSelfHostedGitlab,
  pinSelfHostedGitlabProvider,
} from '../self-hosted-gitlab'

const safeFetchMock = vi.mocked(safeFetch)
const ISSUER = 'https://gitlab.acme.example'
const REDIRECT_URI = 'https://qb.example/api/auth/callback/gitlab'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function formBody(call: number): URLSearchParams {
  return new URLSearchParams(safeFetchMock.mock.calls[call][1]?.body ?? '')
}

// Better-Auth's GitLab provider fetches with the global fetch; on a pinned
// provider any call to it is an unpinned server-side fetch.
const fetchSpy = vi.spyOn(globalThis, 'fetch')

beforeEach(() => {
  safeFetchMock.mockReset()
  fetchSpy.mockReset()
  fetchSpy.mockImplementation(async () => {
    throw new Error('unpinned global fetch')
  })
})

afterAll(() => {
  fetchSpy.mockRestore()
})

function selfHosted(extra: Partial<Parameters<typeof gitlab>[0]> = {}) {
  return gitlab({ clientId: 'gl-client', clientSecret: 'gl-secret', issuer: ISSUER, ...extra })
}

describe('self-hosted GitLab fetches', () => {
  it('derives the endpoints exactly as Better-Auth does', () => {
    expect(gitlabEndpoints('https://gitlab.acme.example/')).toEqual({
      authorizationEndpoint: 'https://gitlab.acme.example/oauth/authorize',
      tokenEndpoint: 'https://gitlab.acme.example/oauth/token',
      userinfoEndpoint: 'https://gitlab.acme.example/api/v4/user',
    })
  })

  it('exchanges the code, looks up the user and refreshes only through safeFetch', async () => {
    const mapProfileToUser = vi.fn(async () => ({ locale: 'en' }))
    const provider = selfHosted({ mapProfileToUser })
    safeFetchMock
      .mockResolvedValueOnce(json({ access_token: 'access-1', refresh_token: 'refresh-1' }))
      .mockResolvedValueOnce(
        json({ id: 42, state: 'active', name: 'Ada', email: 'ada@acme.example' })
      )
      .mockResolvedValueOnce(json({ access_token: 'access-2', expires_in: 3600 }))

    expect(pinSelfHostedGitlabProvider([provider])).toBe(true)
    const tokens = await provider.validateAuthorizationCode({
      code: 'code-1',
      redirectURI: REDIRECT_URI,
      codeVerifier: 'v'.repeat(43),
    })
    if (!tokens) throw new Error('expected tokens')
    const info = await provider.getUserInfo(tokens)
    const refreshed = await provider.refreshAccessToken?.('refresh-1')

    expect(safeFetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${ISSUER}/oauth/token`,
      `${ISSUER}/api/v4/user`,
      `${ISSUER}/oauth/token`,
    ])
    const exchange = formBody(0)
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('code-1')
    expect(exchange.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(exchange.get('client_id')).toBe('gl-client')
    expect(exchange.get('client_secret')).toBe('gl-secret')
    expect(tokens.accessToken).toBe('access-1')
    expect(safeFetchMock.mock.calls[1][1]?.headers?.authorization).toBe('Bearer access-1')
    expect(info?.user).toMatchObject({ id: 42, email: 'ada@acme.example', locale: 'en' })
    expect(mapProfileToUser).toHaveBeenCalledTimes(1)
    expect(formBody(2).get('grant_type')).toBe('refresh_token')
    expect(refreshed).toMatchObject({ accessToken: 'access-2' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a blocked or inactive GitLab account, as Better-Auth does', async () => {
    const provider = selfHosted()
    pinSelfHostedGitlabProvider([provider])
    safeFetchMock
      .mockResolvedValueOnce(json({ id: 1, state: 'blocked', email: 'a@acme.example' }))
      .mockResolvedValueOnce(
        json({ id: 1, state: 'active', locked: true, email: 'a@acme.example' })
      )

    await expect(provider.getUserInfo({ accessToken: 'access-1' })).resolves.toBeNull()
    await expect(provider.getUserInfo({ accessToken: 'access-1' })).resolves.toBeNull()
  })

  it('fails closed when the issuer rebinds to a private address', async () => {
    const provider = selfHosted()
    pinSelfHostedGitlabProvider([provider])
    safeFetchMock.mockRejectedValue(new SsrfError('ssrf-rejected'))

    await expect(
      provider.validateAuthorizationCode({ code: 'code-1', redirectURI: REDIRECT_URI })
    ).rejects.toBeInstanceOf(SsrfError)
    await expect(provider.getUserInfo({ accessToken: 'access-1' })).resolves.toBeNull()
    await expect(provider.refreshAccessToken?.('refresh-1')).rejects.toBeInstanceOf(SsrfError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // An issuer saved before the save-time https rule can still be plain http.
  // The pinned methods then refuse every fetch instead of sending the client
  // secret or the access token in clear.
  it('refuses every fetch for a plain-http issuer', async () => {
    const provider = selfHosted({ issuer: 'http://gitlab.acme.example' })

    expect(pinSelfHostedGitlabProvider([provider])).toBe(true)
    await expect(
      provider.validateAuthorizationCode({ code: 'code-1', redirectURI: REDIRECT_URI })
    ).rejects.toThrow(/no discovery URL or manual endpoints/)
    await expect(provider.getUserInfo({ accessToken: 'access-1' })).resolves.toBeNull()
    await expect(provider.refreshAccessToken?.('refresh-1')).rejects.toThrow(
      /no discovery URL or manual endpoints/
    )
    expect(safeFetchMock).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('leaves gitlab.com and other providers untouched', () => {
    const hosted = gitlab({ clientId: 'gl-client', clientSecret: 'gl-secret' })
    const exchange = hosted.validateAuthorizationCode
    const other = { id: 'github', validateAuthorizationCode: vi.fn() }

    expect(pinSelfHostedGitlabProvider([other, hosted])).toBe(false)
    expect(hosted.validateAuthorizationCode).toBe(exchange)
    expect(pinSelfHostedGitlabProvider(undefined)).toBe(false)
  })

  it('patches the provider from its plugin init', () => {
    const provider = selfHosted()
    const exchange = provider.validateAuthorizationCode

    pinSelfHostedGitlab().init({ socialProviders: [provider] })

    expect(provider.validateAuthorizationCode).not.toBe(exchange)
  })
})
