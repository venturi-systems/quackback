import { describe, it, expect } from 'vitest'
import { asBadRequest, consentClientId, isIncompleteConsentRequest } from '../oauth-consent-status'

const at = (path: string, method = 'GET') =>
  new Request(`http://feedback.example${path}`, { method })

describe('consentClientId mirrors what the consent page reads', () => {
  it.each([
    [null, undefined],
    ['', undefined],
    ['""', undefined],
    ['null', undefined],
    ['[1]', undefined],
    ['{}', undefined],
    ['123', '123'],
    ['true', 'true'],
    ['client_abc', 'client_abc'],
    ['"quoted"', 'quoted'],
  ])('%j reads as %j', (raw, expected) => {
    expect(consentClientId(raw)).toBe(expected)
  })
})

describe('isIncompleteConsentRequest', () => {
  it('flags a consent page that names no application', () => {
    expect(isIncompleteConsentRequest(at('/oauth/consent'))).toBe(true)
    expect(isIncompleteConsentRequest(at('/oauth/consent/'))).toBe(true)
    expect(isIncompleteConsentRequest(at('/oauth/consent?client_id='))).toBe(true)
    expect(isIncompleteConsentRequest(at('/oauth/consent?client_id=%5B1%5D&scope=%7B%7D'))).toBe(
      true
    )
    expect(isIncompleteConsentRequest(at('/oauth/consent', 'HEAD'))).toBe(true)
  })

  it('leaves a named client, another path and a non-read method alone', () => {
    expect(isIncompleteConsentRequest(at('/oauth/consent?client_id=123'))).toBe(false)
    expect(isIncompleteConsentRequest(at('/oauth/consent?client_id=abc&state=1'))).toBe(false)
    expect(isIncompleteConsentRequest(at('/oauth/consented'))).toBe(false)
    expect(isIncompleteConsentRequest(at('/'))).toBe(false)
    expect(isIncompleteConsentRequest(at('/oauth/consent', 'POST'))).toBe(false)
  })
})

describe('asBadRequest', () => {
  it('keeps the page and its headers and answers 400', async () => {
    const page = new Response('<p>incomplete</p>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    const res = asBadRequest(page)
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('<p>incomplete</p>')
  })

  it('leaves a redirect or an error as it is', () => {
    const redirect = new Response(null, { status: 307, headers: { location: '/' } })
    expect(asBadRequest(redirect)).toBe(redirect)
    const failure = new Response('x', { status: 500 })
    expect(asBadRequest(failure)).toBe(failure)
  })
})
