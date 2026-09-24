import { describe, expect, it } from 'vitest'
import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'
import {
  authSettingsSearch,
  completeSignupSearch,
  magicLinkSearch,
  oauthConsentSearch,
  oauthText,
  queryText,
  resetPasswordSearch,
  signinRedirectSearch,
  widgetHandoffSearch,
} from '../auth-route-search'
import { safeSigninRedirect } from '../auth-prompt'

/**
 * DEF-55: `/auth/login?error=123`, `/auth/login?callbackUrl=123`,
 * `/admin/login?error=123` and `/auth/signup?callbackUrl=123` answered HTTP
 * 500 and printed the raw zod issue ("Invalid input: expected string,
 * received number") into the page.
 *
 * Every case here goes through TanStack's own JSON-first query parser, the
 * input the router hands `validateSearch`, and then through the schema the
 * way router-core calls it (Standard Schema `validate`, or the plain
 * function). A result with issues, or a function that throws, is exactly
 * what became a 500.
 */

type StandardResult = { value?: Record<string, unknown>; issues?: ReadonlyArray<unknown> }
type StandardSchema = { '~standard': { validate: (input: unknown) => StandardResult } }

/** Query strings a person can type, paste or follow from another site. */
const HOSTILE_QUERIES = [
  '',
  '?error=123',
  '?callbackUrl=123',
  '?error=123&callbackUrl=123',
  '?error=true&callbackUrl=false',
  '?error=null&callbackUrl=null',
  '?error=%5B%22a%22%5D&callbackUrl=%5B%22%2Fadmin%22%5D',
  '?error=%7B%22a%22%3A1%7D&callbackUrl=%7B%22href%22%3A%22%2Fadmin%22%7D',
  '?error=%00&callbackUrl=%2Fadmin%00',
  '?error=not_team_member&callbackUrl=%2Fadmin%2Fsettings',
  '?error=__proto__&callbackUrl=constructor',
  '?callbackUrl=%2F%2Fevil.example&error=%3Cscript%3E',
  '?callbackUrl=%2F%09%2Fevil.example',
  '?callbackUrl=https%3A%2F%2Fevil.example',
  '?error=1e3&callbackUrl=-1',
  '?error=a&error=b',
  '?tab=bogus',
  '?tab=123',
  '?tab=team-access',
  '?tab=sign-in',
  '?tab=%5B%22sign-in%22%5D',
  '?client_id=123&state=456&exp=1700000000&sig=true',
  '?client_id=%5B1%5D&scope=%7B%7D&state=null',
  '?client_id=app&scope=openid%20profile&state=%22123%22',
  '?token=123&error=%5B1%5D',
  '?token=%7B%7D&callbackURL=123&errorCallbackURL=%5B%5D',
  '?ott=123&returnTo=%5B%22%2F%22%5D',
  '?ott=abc&returnTo=%2Fb%2Fideas',
]

const SCHEMAS: Array<[string, unknown]> = [
  ['signinRedirectSearch (/auth/login, /auth/signup, /admin/login)', signinRedirectSearch],
  ['oauthConsentSearch (/oauth/consent)', oauthConsentSearch],
  ['widgetHandoffSearch (/auth/widget-handoff)', widgetHandoffSearch],
  ['authSettingsSearch (/admin/settings/security/authentication)', authSettingsSearch],
]

const FUNCTIONS: Array<[string, (search: Record<string, unknown>) => Record<string, unknown>]> = [
  ['resetPasswordSearch (/auth/reset-password)', resetPasswordSearch],
  ['magicLinkSearch (/verify-magic-link)', magicLinkSearch],
  ['completeSignupSearch (/complete-signup/$id)', completeSignupSearch],
]

/** What the router's validateSearch does with the query string of a request. */
function validate(schema: unknown, query: string): StandardResult {
  const result = (schema as StandardSchema)['~standard'].validate(defaultParseSearch(query))
  if (result instanceof Promise) throw new Error('validateSearch must stay synchronous')
  return result
}

/** The validated value of `query`, which must carry no issues. */
function valueOf(schema: unknown, query: string): Record<string, unknown> {
  const result = validate(schema, query)
  expect(result.issues).toBeUndefined()
  return result.value ?? {}
}

describe.each(SCHEMAS)('%s', (_name, schema) => {
  it.each(HOSTILE_QUERIES)('accepts %j without a validation error', (query) => {
    expect(validate(schema, query).issues).toBeUndefined()
  })

  // On the server the router redirects to the URL built from the validated
  // values, so that URL must validate to the same values or it would never
  // settle.
  it.each(HOSTILE_QUERIES)('settles the canonical redirect for %j', (query) => {
    const first = valueOf(schema, query)
    const second = valueOf(schema, defaultStringifySearch(first))
    expect(second).toEqual(first)
  })
})

describe.each(FUNCTIONS)('%s', (_name, fn) => {
  it.each(HOSTILE_QUERIES)('reads %j without throwing, as text or nothing', (query) => {
    const value = fn(defaultParseSearch(query))
    for (const field of Object.values(value)) {
      expect(field === undefined || typeof field === 'string').toBe(true)
    }
  })

  it.each(HOSTILE_QUERIES)('settles the canonical redirect for %j', (query) => {
    const first = fn(defaultParseSearch(query))
    const second = fn(defaultParseSearch(defaultStringifySearch(first)))
    expect(second).toEqual(first)
  })
})

/** The typed value the sign-in routes read from `query`. */
function signin(query: string) {
  return signinRedirectSearch.parse(defaultParseSearch(query))
}

describe('signinRedirectSearch', () => {
  it('reads a numeric error or callbackUrl as its text', () => {
    expect(valueOf(signinRedirectSearch, '?error=123&callbackUrl=123')).toEqual({
      error: '123',
      callbackUrl: '123',
    })
  })

  it('reads a list, an object, null or a NUL as absent', () => {
    for (const query of [
      '?error=%5B%22a%22%5D&callbackUrl=%5B%22%2Fadmin%22%5D',
      '?error=%7B%22a%22%3A1%7D&callbackUrl=%7B%7D',
      '?error=null&callbackUrl=null',
      '?error=%00&callbackUrl=%2Fadmin%00',
    ]) {
      expect(valueOf(signinRedirectSearch, query)).toEqual({
        error: undefined,
        callbackUrl: undefined,
      })
    }
  })

  // The sign-in routes turn the validated values into the portal sign-in
  // redirect. A malformed or foreign callbackUrl must fall back, never leave
  // the origin, and a code is only ever carried as text.
  it('turns hostile values into a same-origin sign-in redirect', () => {
    expect(safeSigninRedirect(signin('?error=123&callbackUrl=123'), '/')).toEqual({
      to: '/',
      search: { auth: 'signin', callbackUrl: '/', error: '123' },
    })
    for (const query of [
      '?callbackUrl=%2F%2Fevil.example',
      '?callbackUrl=https%3A%2F%2Fevil.example',
      '?callbackUrl=%2F%09%2Fevil.example',
      '?callbackUrl=%2F%5Cevil.example',
    ]) {
      const target = safeSigninRedirect(signin(query), '/admin')
      expect(target.search.callbackUrl).toBe('/admin')
    }
  })

  it('keeps a real deep link and a real code', () => {
    const target = safeSigninRedirect(
      signin('?error=not_team_member&callbackUrl=%2Fadmin%2Fsettings'),
      '/'
    )
    expect(target.search).toEqual({
      auth: 'signin',
      callbackUrl: '/admin/settings',
      error: 'not_team_member',
    })
  })
})

describe('authSettingsSearch', () => {
  it('opens a known tab', () => {
    expect(valueOf(authSettingsSearch, '?tab=sign-in')).toEqual({ tab: 'sign-in' })
    expect(valueOf(authSettingsSearch, '?tab=portal-access')).toEqual({ tab: 'portal-access' })
  })

  it('opens the retired team-access tab as sign-in', () => {
    expect(valueOf(authSettingsSearch, '?tab=team-access')).toEqual({ tab: 'sign-in' })
  })

  it('opens the default tab for any other value', () => {
    for (const query of ['?tab=bogus', '?tab=123', '?tab=%5B%22sign-in%22%5D', '?tab=null', '']) {
      expect(valueOf(authSettingsSearch, query).tab).toBeUndefined()
    }
  })
})

describe('oauthConsentSearch', () => {
  // The consent page posts its own query string back, and the authorization
  // server checks it against the signature it issued. A number must stay a
  // number, or the canonical redirect would rewrite `state=12345` as
  // `state=%2212345%22`, a different state.
  it('keeps each value in the shape the parser delivered it', () => {
    const value = valueOf(oauthConsentSearch, '?client_id=123&state=12345&exp=1700000000')
    expect(value).toMatchObject({ client_id: 123, state: 12345, exp: 1700000000 })
    expect(defaultStringifySearch(value)).toBe('?client_id=123&state=12345&exp=1700000000')
  })

  it('renders a request without a client_id instead of failing validation', () => {
    expect(valueOf(oauthConsentSearch, '?scope=openid').client_id).toBeUndefined()
  })

  it('reads a list, an object or null as absent', () => {
    const value = valueOf(oauthConsentSearch, '?client_id=%5B1%5D&scope=%7B%7D&state=null')
    expect(value.client_id).toBeUndefined()
    expect(value.scope).toBeUndefined()
    expect(value.state).toBeUndefined()
  })

  it('gives the page text for display and lookup', () => {
    expect(oauthText(123)).toBe('123')
    expect(oauthText(true)).toBe('true')
    expect(oauthText('app')).toBe('app')
    expect(oauthText(undefined)).toBeUndefined()
  })
})

describe('the function validators', () => {
  it('read the reset-password token and error as text, empty when unusable', () => {
    expect(resetPasswordSearch(defaultParseSearch('?token=123&error=%5B1%5D'))).toEqual({
      token: '123',
      error: '',
    })
    expect(resetPasswordSearch({})).toEqual({ token: '', error: '' })
  })

  it('never hand the magic-link page a list or an object', () => {
    expect(
      magicLinkSearch(defaultParseSearch('?token=%7B%7D&callbackURL=123&errorCallbackURL=%5B%5D'))
    ).toEqual({ token: undefined, callbackURL: '123', errorCallbackURL: undefined })
  })

  it('read the invitation error code as text', () => {
    expect(completeSignupSearch(defaultParseSearch('?error=123'))).toEqual({ error: '123' })
    expect(completeSignupSearch(defaultParseSearch('?error=%5B1%5D'))).toEqual({
      error: undefined,
    })
  })

  it('queryText never throws', () => {
    for (const value of [undefined, null, 1, true, 'a', [], {}, ['a'], { a: 1 }, 'a\u0000']) {
      expect(() => queryText(value)).not.toThrow()
    }
    expect(queryText(1)).toBe('1')
    expect(queryText(['a'])).toBeUndefined()
    expect(queryText('a\u0000')).toBeUndefined()
  })
})
