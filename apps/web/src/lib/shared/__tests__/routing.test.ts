import { describe, it, expect } from 'vitest'
import { isSafeCallbackUrl, isTeamCallback, teamSigninCallback } from '../routing'

describe('isSafeCallbackUrl', () => {
  // Accepted values
  it('accepts "/"', () => {
    expect(isSafeCallbackUrl('/')).toBe(true)
  })

  it('accepts "/portal-invite/abc"', () => {
    expect(isSafeCallbackUrl('/portal-invite/abc')).toBe(true)
  })

  it('accepts "/some/deep/path?q=1"', () => {
    expect(isSafeCallbackUrl('/some/deep/path?q=1')).toBe(true)
  })

  it('accepts paths with hyphens and underscores', () => {
    expect(isSafeCallbackUrl('/admin/settings-permissions')).toBe(true)
  })

  // Rejected values — open-redirect vectors
  it('rejects "//evil.com" (protocol-relative)', () => {
    expect(isSafeCallbackUrl('//evil.com')).toBe(false)
  })

  it('rejects "https://evil.com" (absolute URL)', () => {
    expect(isSafeCallbackUrl('https://evil.com')).toBe(false)
  })

  it('rejects "http://evil.com"', () => {
    expect(isSafeCallbackUrl('http://evil.com')).toBe(false)
  })

  it('rejects "javascript:alert(1)" (script-protocol)', () => {
    expect(isSafeCallbackUrl('javascript:alert(1)')).toBe(false)
  })

  it('rejects plain "evil.com" (no leading slash)', () => {
    expect(isSafeCallbackUrl('evil.com')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isSafeCallbackUrl('')).toBe(false)
  })

  it('rejects undefined', () => {
    expect(isSafeCallbackUrl(undefined)).toBe(false)
  })

  it('rejects null', () => {
    expect(isSafeCallbackUrl(null)).toBe(false)
  })

  it('rejects a number', () => {
    expect(isSafeCallbackUrl(42)).toBe(false)
  })

  // Backslash open-redirect: some browsers normalise /\evil.com → //evil.com
  it('rejects "/\\evil.com" (backslash redirect)', () => {
    expect(isSafeCallbackUrl('/\\evil.com')).toBe(false)
  })

  it('rejects "/\\\\evil.com" (double-backslash redirect)', () => {
    expect(isSafeCallbackUrl('/\\\\evil.com')).toBe(false)
  })

  it('still accepts "/admin" (regression)', () => {
    expect(isSafeCallbackUrl('/admin')).toBe(true)
  })

  // A browser strips tab, CR and LF before resolving a URL, so each of these
  // would navigate as `//evil.com`, another origin.
  it.each(['/\t/evil.com', '/\n/evil.com', '/\r/evil.com', '/\t\t/evil.com'])(
    'rejects %j, which a browser reads as protocol-relative',
    (url) => {
      expect(isSafeCallbackUrl(url)).toBe(false)
    }
  )

  it('rejects any other control character', () => {
    expect(isSafeCallbackUrl('/admin\u0000')).toBe(false)
    expect(isSafeCallbackUrl('/admin\u007f')).toBe(false)
    expect(isSafeCallbackUrl('/admin\u001b[0m')).toBe(false)
  })

  it('keeps a deep link with its query and fragment', () => {
    expect(isSafeCallbackUrl('/admin/settings?tab=sign-in#oidc')).toBe(true)
    expect(isSafeCallbackUrl('/admin/feedback?board=%5B%22ideas%22%5D')).toBe(true)
  })

  // Each of these resolves to the path `//evil.example` once the URL parser
  // applies its dot segments, so it is refused like `//evil.example` itself.
  it.each([
    '/.//evil.example',
    '/admin/..//evil.example',
    '/admin/%2e%2e//evil.example',
    '/admin/%2E%2E//evil.example',
    '/././/evil.example/admin',
  ])('rejects %j, whose resolved path is protocol-relative', (url) => {
    expect(isSafeCallbackUrl(url)).toBe(false)
  })

  it('still accepts dot segments that stay on an ordinary path', () => {
    expect(isSafeCallbackUrl('/admin/./settings')).toBe(true)
    expect(isSafeCallbackUrl('/admin/../b/ideas')).toBe(true)
  })
})

describe('isTeamCallback', () => {
  it('is true for admin paths', () => {
    expect(isTeamCallback('/admin')).toBe(true)
    expect(isTeamCallback('/admin/feedback')).toBe(true)
  })
  it('is true for team-invitation callbacks', () => {
    expect(isTeamCallback('/complete-signup/inv_123')).toBe(true)
  })
  it('is false for portal paths and undefined', () => {
    expect(isTeamCallback('/')).toBe(false)
    expect(isTeamCallback('/b/roadmap')).toBe(false)
    expect(isTeamCallback('/auth/login')).toBe(false)
    expect(isTeamCallback(undefined)).toBe(false)
  })
  it('is false for non-admin lookalikes', () => {
    expect(isTeamCallback('/administrator-handbook')).toBe(false)
  })
  it('reads only the path, so a team page keeps its query and fragment', () => {
    expect(isTeamCallback('/admin?post=post_1')).toBe(true)
    expect(isTeamCallback('/admin#top')).toBe(true)
    expect(isTeamCallback('/admin/settings?tab=sign-in')).toBe(true)
    expect(isTeamCallback('/?next=/admin')).toBe(false)
    expect(isTeamCallback('/administrator?x=/admin')).toBe(false)
  })
  it('reads the path the browser resolves, after dot segments', () => {
    expect(isTeamCallback('/admin/./settings')).toBe(true)
    expect(isTeamCallback('/b/../admin/feedback')).toBe(true)
    expect(isTeamCallback('/admin/../b/ideas')).toBe(false)
    expect(isTeamCallback('/admin/%2e%2e/b/ideas')).toBe(false)
    expect(isTeamCallback('/admin/..//evil.example')).toBe(false)
  })
  it('is false for a value that is not a same-origin relative path', () => {
    expect(isTeamCallback('admin')).toBe(false)
    expect(isTeamCallback('//evil.example/admin')).toBe(false)
    expect(isTeamCallback('https://evil.example/admin')).toBe(false)
  })
})

// DEF-48: a signed-out visitor on /admin/settings was sent to sign in with
// callbackUrl=/admin, so the deep link was lost.
describe('teamSigninCallback', () => {
  it('keeps the team page that was asked for, with its query and fragment', () => {
    expect(teamSigninCallback('/admin/settings')).toBe('/admin/settings')
    expect(teamSigninCallback('/admin/settings/security/authentication?tab=sign-in')).toBe(
      '/admin/settings/security/authentication?tab=sign-in'
    )
    expect(teamSigninCallback('/admin/feedback#post')).toBe('/admin/feedback#post')
    expect(teamSigninCallback('/complete-signup/inv_123')).toBe('/complete-signup/inv_123')
  })

  it('falls back to /admin when nothing was asked for', () => {
    expect(teamSigninCallback(undefined)).toBe('/admin')
    expect(teamSigninCallback('')).toBe('/admin')
  })

  it.each([
    '//evil.example/admin',
    'https://evil.example/admin',
    '/\\evil.example',
    '/\t/evil.example',
    '/admin\u0000',
    '/.//evil.example',
    '/admin/..//evil.example',
    '/admin/%2e%2e//evil.example',
    '/admin/../b/ideas',
    'javascript:alert(1)',
    '/b/ideas',
    '/',
    '/administrator',
    123,
    { href: '/admin/settings' },
  ])('falls back to /admin for %j, which is not a same-origin team page', (requested) => {
    expect(teamSigninCallback(requested)).toBe('/admin')
  })

  it('falls back to /admin for a list, which is not text', () => {
    expect(teamSigninCallback(['/admin/settings'])).toBe('/admin')
  })
})
