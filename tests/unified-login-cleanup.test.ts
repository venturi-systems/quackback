import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  type Journey = (fixtures: {
    page?: unknown
    context?: unknown
    browser?: unknown
  }) => Promise<void>
  const journeys = new Map<string, Journey>()
  const assertions = {
    toBe: vi.fn(),
    toContain: vi.fn(),
    toBeVisible: vi.fn(async () => {}),
    toHaveURL: vi.fn(async () => {}),
    toHaveCount: vi.fn(async () => {}),
    toHaveAttribute: vi.fn(async () => {}),
  }
  const negatedAssertions = { toMatch: vi.fn() }
  const test = Object.assign(
    (title: string, journey: Journey) => {
      journeys.set(title, journey)
    },
    {
      describe: { configure: vi.fn() },
      // Capture registration without running global setup or browser hooks.
      beforeAll: vi.fn(),
      beforeEach: vi.fn(),
    }
  )
  const helpers = {
    loginViaMagicLink: vi.fn(),
    setPortalAuthMethods: vi.fn(),
    setPortalVisibility: vi.fn(),
    flushMagicLinkRateLimit: vi.fn(),
    seedIdentityProvider: vi.fn(),
    removeIdentityProvider: vi.fn(),
  }
  return {
    journeys,
    assertions,
    negatedAssertions,
    test,
    helpers,
    readFileSync: vi.fn(),
    expect: vi.fn(() => ({ ...assertions, not: negatedAssertions })),
  }
})

// Playwright is an app dependency; mock its workspace entry, not a root-only virtual module.
vi.mock('../apps/web/node_modules/@playwright/test', () => ({
  test: harness.test,
  expect: harness.expect,
}))
vi.mock('../apps/web/e2e/utils/access-helpers', () => harness.helpers)
vi.mock('fs', () => ({ readFileSync: harness.readFileSync }))

// Import the real callbacks while replacing every fixture boundary. No browser,
// stored auth state, database, provider discovery, or BroadcastChannel is used.
import '../apps/web/e2e/tests/auth/unified-login.spec'

beforeEach(() => {
  for (const helper of Object.values(harness.helpers)) helper.mockReset()
  for (const assertion of Object.values(harness.assertions)) assertion.mockClear()
  harness.negatedAssertions.toMatch.mockClear()
  harness.expect.mockClear()
  harness.readFileSync.mockReset().mockReturnValue('{"cookies":[]}')
})

function journey(number: string) {
  const selected = [...harness.journeys].filter(([title]) => title.startsWith('(' + number + ') '))
  expect(selected).toHaveLength(1)
  return selected[0][1]
}

function mockPage(onGoto: () => Promise<void>) {
  const locator = {
    first: vi.fn(() => ({})),
    filter: vi.fn(() => ({})),
    fill: vi.fn(async () => {}),
    press: vi.fn(async () => {}),
  }
  const context = { addCookies: vi.fn(async () => {}) }
  return {
    goto: vi.fn(onGoto),
    waitForLoadState: vi.fn(async () => {}),
    getByRole: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    locator: vi.fn(() => locator),
    context: vi.fn(() => context),
    // Deliberately do not evaluate the browser callback.
    evaluate: vi.fn(async () => {}),
    waitForResponse: vi.fn(async () => ({
      text: async () => 'sso-redirect e2e-unified-corp',
    })),
    url: vi.fn(() => 'https://acme.example/?auth=signin&error=not_team_member'),
    close: vi.fn(async () => {}),
  }
}

// These tests assert ordinary try/finally error precedence: the last failing
// cleanup replaces an earlier error. All cleanup errors still reject; cleanup
// attempts do not imply successful restoration when a helper itself fails.
describe('unified login journey one context cleanup', () => {
  const cases = [
    { name: 'success', faults: [] },
    { name: 'context creation failure', faults: ['context'] },
    { name: 'page creation failure', faults: ['page'] },
    { name: 'body failure', faults: ['body'] },
    { name: 'context close failure', faults: ['close'] },
    { name: 'page creation and close failure', faults: ['page', 'close'] },
    { name: 'body and close failure', faults: ['body', 'close'] },
  ]

  it.each(cases)('closes every acquired context after $name', async ({ faults }) => {
    const calls: string[] = []
    const errors = {
      context: new Error('context creation'),
      page: new Error('page creation'),
      body: new Error('journey body'),
      close: new Error('context close'),
    }
    const page = mockPage(async () => {
      calls.push('body')
      if (faults.includes('body')) throw errors.body
    })
    let contextOpen = false
    const context = {
      newPage: vi.fn(async () => {
        calls.push('page')
        if (faults.includes('page')) throw errors.page
        return page
      }),
      close: vi.fn(async () => {
        calls.push('close')
        if (faults.includes('close')) throw errors.close
        contextOpen = false
      }),
    }
    const browser = {
      newContext: vi.fn(async () => {
        calls.push('context')
        if (faults.includes('context')) throw errors.context
        contextOpen = true
        return context
      }),
    }
    const expectedError = faults.includes('context')
      ? errors.context
      : faults.includes('close')
        ? errors.close
        : faults.includes('page')
          ? errors.page
          : faults.includes('body')
            ? errors.body
            : undefined
    if (expectedError) await expect(journey('1b')({ browser })).rejects.toBe(expectedError)
    else await expect(journey('1b')({ browser })).resolves.toBeUndefined()

    expect(browser.newContext).toHaveBeenCalledExactlyOnceWith({
      storageState: 'e2e/.auth/admin.json',
    })
    expect(calls).toEqual(
      faults.includes('context')
        ? ['context']
        : ['context', 'page', ...(faults.includes('page') ? [] : ['body']), 'close']
    )
    expect(contextOpen).toBe(!faults.includes('context') && faults.includes('close'))
    expect(harness.readFileSync).not.toHaveBeenCalled()
    for (const helper of Object.values(harness.helpers)) expect(helper).not.toHaveBeenCalled()
  })
})

describe('unified login journey two method and page cleanup', () => {
  const cases = [
    { name: 'success', faults: [] },
    { name: 'enable after write failure', faults: ['enable'] },
    { name: 'login failure', faults: ['login'] },
    { name: 'restoration failure', faults: ['restore'] },
    { name: 'enable and restoration failure', faults: ['enable', 'restore'] },
    { name: 'login and restoration failure', faults: ['login', 'restore'] },
    { name: 'page creation failure', faults: ['page'] },
    { name: 'page body failure', faults: ['body'] },
    { name: 'page close failure', faults: ['close'] },
    { name: 'page body and close failure', faults: ['body', 'close'] },
  ]

  it.each(cases)(
    'attempts restoration and closes acquired pages after $name',
    async ({ faults }) => {
      const calls: string[] = []
      const errors = {
        enable: new Error('enable after write'),
        login: new Error('login'),
        restore: new Error('auth restoration'),
        page: new Error('page creation'),
        body: new Error('page body'),
        close: new Error('page close'),
      }
      let authEnabled = false
      let pageOpen = false
      harness.helpers.setPortalAuthMethods.mockImplementation((action: string) => {
        if (action === 'enable-magic-link') {
          calls.push('enable')
          authEnabled = true
          if (faults.includes('enable')) throw errors.enable
        } else {
          expect(action).toBe('restore')
          calls.push('restore')
          if (faults.includes('restore')) throw errors.restore
          authEnabled = false
        }
      })
      harness.helpers.loginViaMagicLink.mockImplementation(async () => {
        calls.push('login')
        if (faults.includes('login')) throw errors.login
      })
      const page = mockPage(async () => {
        calls.push('body')
        if (faults.includes('body')) throw errors.body
      })
      page.close.mockImplementation(async () => {
        calls.push('close')
        if (faults.includes('close')) throw errors.close
        pageOpen = false
      })
      const context = {
        newPage: vi.fn(async () => {
          calls.push('page')
          if (faults.includes('page')) throw errors.page
          pageOpen = true
          return page
        }),
      }
      const setupFailed = faults.some((fault) => ['enable', 'login', 'restore'].includes(fault))
      const expectedError = faults.includes('restore')
        ? errors.restore
        : faults.includes('enable')
          ? errors.enable
          : faults.includes('login')
            ? errors.login
            : faults.includes('page')
              ? errors.page
              : faults.includes('close')
                ? errors.close
                : faults.includes('body')
                  ? errors.body
                  : undefined
      if (expectedError) await expect(journey('2')({ context })).rejects.toBe(expectedError)
      else await expect(journey('2')({ context })).resolves.toBeUndefined()

      expect(harness.helpers.setPortalAuthMethods.mock.calls).toEqual([
        ['enable-magic-link'],
        ['restore'],
      ])
      expect(harness.helpers.loginViaMagicLink).toHaveBeenCalledTimes(
        faults.includes('enable') ? 0 : 1
      )
      if (!faults.includes('enable')) {
        expect(harness.helpers.loginViaMagicLink).toHaveBeenCalledWith(
          context,
          'e2e-portal-unified@example.test',
          { role: 'user' }
        )
      }
      expect(calls).toEqual([
        'enable',
        ...(faults.includes('enable') ? [] : ['login']),
        'restore',
        ...(setupFailed ? [] : ['page']),
        ...(setupFailed || faults.includes('page') ? [] : ['body', 'close']),
      ])
      expect(authEnabled).toBe(faults.includes('restore'))
      expect(pageOpen).toBe(!setupFailed && !faults.includes('page') && faults.includes('close'))
      expect(harness.readFileSync).not.toHaveBeenCalled()
      expect(harness.helpers.setPortalVisibility).not.toHaveBeenCalled()
      expect(harness.helpers.seedIdentityProvider).not.toHaveBeenCalled()
      expect(harness.helpers.removeIdentityProvider).not.toHaveBeenCalled()
    }
  )
})

describe('unified login journey three visibility cleanup', () => {
  const cases = [
    { name: 'success', faults: [] },
    { name: 'private visibility after write failure', faults: ['private'] },
    { name: 'body failure', faults: ['body'] },
    { name: 'public restoration failure', faults: ['public'] },
    { name: 'private and public failures', faults: ['private', 'public'] },
    { name: 'body and public failure', faults: ['body', 'public'] },
  ]

  it.each(cases)('attempts public restoration after $name', async ({ faults }) => {
    const calls: string[] = []
    const errors = {
      private: new Error('private visibility after write'),
      body: new Error('journey body'),
      public: new Error('public restoration'),
    }
    let isPrivate = false
    harness.helpers.setPortalVisibility.mockImplementation((visibility: string) => {
      calls.push(visibility)
      if (visibility === 'private') {
        isPrivate = true
        if (faults.includes('private')) throw errors.private
      } else {
        expect(visibility).toBe('public')
        if (faults.includes('public')) throw errors.public
        isPrivate = false
      }
    })
    const page = mockPage(async () => {
      calls.push('body')
      if (faults.includes('body')) throw errors.body
    })
    const expectedError = faults.includes('public')
      ? errors.public
      : faults.includes('private')
        ? errors.private
        : faults.includes('body')
          ? errors.body
          : undefined
    if (expectedError) await expect(journey('3')({ page })).rejects.toBe(expectedError)
    else await expect(journey('3')({ page })).resolves.toBeUndefined()

    expect(harness.helpers.setPortalVisibility.mock.calls).toEqual([['private'], ['public']])
    expect(calls).toEqual(['private', ...(faults.includes('private') ? [] : ['body']), 'public'])
    expect(isPrivate).toBe(faults.includes('public'))
    const reachedSession = !faults.includes('private') && !faults.includes('body')
    expect(harness.readFileSync).toHaveBeenCalledTimes(reachedSession ? 1 : 0)
    expect(page.evaluate).toHaveBeenCalledTimes(reachedSession ? 1 : 0)
    if (reachedSession) {
      expect(harness.readFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/e2e\/\.auth\/admin\.json$/),
        'utf-8'
      )
      expect(page.context().addCookies).toHaveBeenCalledExactlyOnceWith([])
    }
    expect(harness.helpers.setPortalAuthMethods).not.toHaveBeenCalled()
    expect(harness.helpers.loginViaMagicLink).not.toHaveBeenCalled()
    expect(harness.helpers.seedIdentityProvider).not.toHaveBeenCalled()
    expect(harness.helpers.removeIdentityProvider).not.toHaveBeenCalled()
  })
})

describe('unified login journey four provider and method cleanup', () => {
  const cases = [
    { name: 'success', faults: [] },
    { name: 'partial seed failure', faults: ['seed'] },
    { name: 'disable after write failure', faults: ['disable'] },
    { name: 'body failure', faults: ['body'] },
    { name: 'removal failure', faults: ['remove'] },
    { name: 'restoration failure', faults: ['restore'] },
    { name: 'partial seed and removal failure', faults: ['seed', 'remove'] },
    { name: 'body and removal failure', faults: ['body', 'remove'] },
    { name: 'both cleanup failures', faults: ['remove', 'restore'] },
    { name: 'body and both cleanup failures', faults: ['body', 'remove', 'restore'] },
  ]

  it.each(cases)('attempts both cleanups after $name', async ({ faults }) => {
    const calls: string[] = []
    const errors = {
      seed: new Error('partial seed'),
      disable: new Error('disable after write'),
      body: new Error('journey body'),
      remove: new Error('provider removal'),
      restore: new Error('auth restoration'),
    }
    let providerExists = false
    let authDisabled = false
    harness.helpers.seedIdentityProvider.mockImplementation(() => {
      calls.push('seed')
      providerExists = true
      if (faults.includes('seed')) throw errors.seed
    })
    harness.helpers.setPortalAuthMethods.mockImplementation((action: string) => {
      calls.push(action)
      if (action === 'disable') {
        authDisabled = true
        if (faults.includes('disable')) throw errors.disable
      } else {
        expect(action).toBe('restore')
        if (faults.includes('restore')) throw errors.restore
        authDisabled = false
      }
    })
    harness.helpers.removeIdentityProvider.mockImplementation(() => {
      calls.push('remove')
      if (faults.includes('remove')) throw errors.remove
      providerExists = false
    })
    const page = mockPage(async () => {
      calls.push('body')
      if (faults.includes('body')) throw errors.body
    })
    const expectedError = faults.includes('restore')
      ? errors.restore
      : faults.includes('remove')
        ? errors.remove
        : faults.includes('seed')
          ? errors.seed
          : faults.includes('disable')
            ? errors.disable
            : faults.includes('body')
              ? errors.body
              : undefined
    if (expectedError) await expect(journey('4')({ page })).rejects.toBe(expectedError)
    else await expect(journey('4')({ page })).resolves.toBeUndefined()

    expect(harness.helpers.seedIdentityProvider).toHaveBeenCalledExactlyOnceWith({
      registrationId: 'e2e-unified-btn',
      label: 'E2E Unified Button',
      clientId: 'e2e-unified-btn-client',
      discoveryUrl: 'https://idp.example.org/.well-known/openid-configuration',
      enabled: true,
      showButton: true,
    })
    expect(harness.helpers.removeIdentityProvider).toHaveBeenCalledExactlyOnceWith(
      'e2e-unified-btn'
    )
    expect(harness.helpers.setPortalAuthMethods.mock.calls).toEqual(
      faults.includes('seed') ? [['restore']] : [['disable'], ['restore']]
    )
    expect(calls).toEqual([
      'seed',
      ...(faults.includes('seed') ? [] : ['disable']),
      ...(faults.includes('seed') || faults.includes('disable') ? [] : ['body']),
      'remove',
      'restore',
    ])
    expect(providerExists).toBe(faults.includes('remove'))
    expect(authDisabled).toBe(!faults.includes('seed') && faults.includes('restore'))
    expect(harness.readFileSync).not.toHaveBeenCalled()
    expect(harness.helpers.loginViaMagicLink).not.toHaveBeenCalled()
    expect(harness.helpers.setPortalVisibility).not.toHaveBeenCalled()
  })
})

describe('unified login journey six provider cleanup', () => {
  const cases = [
    { name: 'success', faults: [] },
    { name: 'partial button provider seed failure', faults: ['buttonSeed'] },
    { name: 'partial corporate provider seed failure', faults: ['corpSeed'] },
    { name: 'body failure', faults: ['body'] },
    { name: 'button provider removal failure', faults: ['buttonRemove'] },
    { name: 'corporate provider removal failure', faults: ['corpRemove'] },
    { name: 'partial button seed and removal failure', faults: ['buttonSeed', 'buttonRemove'] },
    {
      name: 'partial corporate seed and first removal failure',
      faults: ['corpSeed', 'buttonRemove'],
    },
    { name: 'both removal failures', faults: ['buttonRemove', 'corpRemove'] },
    { name: 'body and both removal failures', faults: ['body', 'buttonRemove', 'corpRemove'] },
  ]

  it.each(cases)('attempts both provider removals after $name', async ({ faults }) => {
    const calls: string[] = []
    const errors = {
      buttonSeed: new Error('partial button seed'),
      corpSeed: new Error('partial corporate seed'),
      body: new Error('journey body'),
      buttonRemove: new Error('button removal'),
      corpRemove: new Error('corporate removal'),
    }
    const providers = new Set<string>()
    harness.helpers.seedIdentityProvider.mockImplementation(
      ({ registrationId }: { registrationId: string }) => {
        const stage = registrationId === 'e2e-unified-btn' ? 'buttonSeed' : 'corpSeed'
        calls.push(stage)
        providers.add(registrationId)
        if (faults.includes(stage)) throw errors[stage]
      }
    )
    harness.helpers.removeIdentityProvider.mockImplementation((registrationId: string) => {
      const stage = registrationId === 'e2e-unified-btn' ? 'buttonRemove' : 'corpRemove'
      calls.push(stage)
      if (faults.includes(stage)) throw errors[stage]
      providers.delete(registrationId)
    })
    const page = mockPage(async () => {
      calls.push('body')
      if (faults.includes('body')) throw errors.body
    })
    const expectedError = faults.includes('corpRemove')
      ? errors.corpRemove
      : faults.includes('buttonRemove')
        ? errors.buttonRemove
        : faults.includes('buttonSeed')
          ? errors.buttonSeed
          : faults.includes('corpSeed')
            ? errors.corpSeed
            : faults.includes('body')
              ? errors.body
              : undefined
    if (expectedError) await expect(journey('6')({ page })).rejects.toBe(expectedError)
    else await expect(journey('6')({ page })).resolves.toBeUndefined()

    expect(
      harness.helpers.seedIdentityProvider.mock.calls.map(([provider]) => provider.registrationId)
    ).toEqual(
      faults.includes('buttonSeed') ? ['e2e-unified-btn'] : ['e2e-unified-btn', 'e2e-unified-corp']
    )
    expect(harness.helpers.removeIdentityProvider.mock.calls).toEqual([
      ['e2e-unified-btn'],
      ['e2e-unified-corp'],
    ])
    expect(calls).toEqual([
      'buttonSeed',
      ...(faults.includes('buttonSeed') ? [] : ['corpSeed']),
      ...(faults.includes('buttonSeed') || faults.includes('corpSeed') ? [] : ['body']),
      'buttonRemove',
      'corpRemove',
    ])
    expect(providers.has('e2e-unified-btn')).toBe(faults.includes('buttonRemove'))
    expect(providers.has('e2e-unified-corp')).toBe(
      !faults.includes('buttonSeed') && faults.includes('corpRemove')
    )
    const reachedLookup = !faults.some((fault) =>
      ['buttonSeed', 'corpSeed', 'body'].includes(fault)
    )
    expect(page.waitForResponse).toHaveBeenCalledTimes(reachedLookup ? 1 : 0)
    expect(harness.readFileSync).not.toHaveBeenCalled()
    expect(harness.helpers.loginViaMagicLink).not.toHaveBeenCalled()
    expect(harness.helpers.setPortalAuthMethods).not.toHaveBeenCalled()
    expect(harness.helpers.setPortalVisibility).not.toHaveBeenCalled()
  })
})
