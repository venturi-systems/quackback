import { constants } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext, type Page } from '@playwright/test'
import { assertDesignFixtureEnvironmentSync } from './design-fixture-guard'
import { assertActualBrowserZoom, type RequiredBrowserZoom } from './browser-zoom-evidence'

const FIXTURE_ORIGIN = 'http://acme.localhost:3000'
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const AUTH_FILE = resolve(WEB_ROOT, 'e2e/.auth/admin.json')

type FixtureStorageState = Awaited<ReturnType<BrowserContext['storageState']>>
type ZoomEvidence = Awaited<ReturnType<typeof assertActualBrowserZoom>>

export type BrowserZoomFixture = {
  context: BrowserContext
  page: Page
  /** Invoke after navigation: Chrome resets per-tab zoom on navigation. */
  setZoom: (factor: RequiredBrowserZoom) => Promise<ZoomEvidence>
}

export type BrowserZoomOptions = {
  baseURL: string | undefined
  viewport: { width: number; height: number }
  /** Read only this disposable checkout's existing e2e/.auth/admin.json. */
  useAdminState?: boolean
}

type ExtensionTabs = {
  query: (query: { url: string }) => Promise<Array<{ id?: number; url?: string }>>
  get: (tabId: number) => Promise<{ id?: number; url?: string }>
  setZoomSettings: (
    tabId: number,
    settings: { mode: 'automatic'; scope: 'per-tab' }
  ) => Promise<void>
  setZoom: (tabId: number, factor: number) => Promise<void>
  getZoom: (tabId: number) => Promise<number>
  getZoomSettings: (tabId: number) => Promise<{ mode?: string; scope?: string }>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readFixtureAdminState(): Promise<FixtureStorageState> {
  const reject = (): never => {
    throw new Error(
      'Zoom fixture admin state is missing or outside the disposable fixture contract'
    )
  }
  const canonicalRoot = await realpath(WEB_ROOT)
  if ((await realpath(AUTH_FILE)) !== join(canonicalRoot, 'e2e/.auth/admin.json')) reject()
  const file = await open(AUTH_FILE, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 1024 * 1024 || info.size === 0) reject()
    let state: unknown
    try {
      state = JSON.parse(await file.readFile('utf8'))
    } catch {
      return reject()
    }
    if (
      !object(state) ||
      Object.keys(state).some((key) => !['cookies', 'origins'].includes(key)) ||
      !Array.isArray(state.cookies) ||
      !Array.isArray(state.origins)
    )
      return reject()
    for (const cookie of state.cookies) {
      if (
        !object(cookie) ||
        Object.keys(cookie).some(
          (key) =>
            ![
              'name',
              'value',
              'domain',
              'path',
              'expires',
              'httpOnly',
              'secure',
              'sameSite',
            ].includes(key)
        ) ||
        typeof cookie.name !== 'string' ||
        !cookie.name ||
        typeof cookie.value !== 'string' ||
        !['acme.localhost', '.acme.localhost'].includes(String(cookie.domain)) ||
        typeof cookie.path !== 'string' ||
        !cookie.path.startsWith('/') ||
        typeof cookie.expires !== 'number' ||
        !Number.isFinite(cookie.expires) ||
        typeof cookie.httpOnly !== 'boolean' ||
        typeof cookie.secure !== 'boolean' ||
        !['Strict', 'Lax', 'None'].includes(String(cookie.sameSite))
      )
        reject()
    }
    for (const origin of state.origins) {
      if (
        !object(origin) ||
        Object.keys(origin).some((key) => !['origin', 'localStorage'].includes(key)) ||
        origin.origin !== FIXTURE_ORIGIN ||
        !Array.isArray(origin.localStorage)
      )
        return reject()
      for (const entry of origin.localStorage) {
        if (
          !object(entry) ||
          Object.keys(entry).some((key) => !['name', 'value'].includes(key)) ||
          typeof entry.name !== 'string' ||
          typeof entry.value !== 'string'
        )
          reject()
      }
    }
    return state as FixtureStorageState
  } finally {
    await file.close()
  }
}

/**
 * Actual browser zoom in one owned, temporary CI profile. NOT_RUN on authoring.
 * No user profile, system browser, CSS zoom, device scale or pinch substitution.
 * This callback closes its context before deleting its own temporary directory.
 * If browser shutdown cannot be confirmed, the owned path is retained and the
 * error names it; no profile is deleted while its browser may still be live.
 *
 * https://playwright.dev/docs/chrome-extensions
 * https://developer.chrome.com/docs/extensions/reference/api/tabs#method-setZoom
 * https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 */
export async function withDesignBrowserZoom<T>(
  options: BrowserZoomOptions,
  use: (fixture: BrowserZoomFixture) => Promise<T>
): Promise<T> {
  // Must run before reading even fixture auth, writing files, or launching.
  assertDesignFixtureEnvironmentSync(options.baseURL)
  if (options.baseURL !== FIXTURE_ORIGIN && options.baseURL !== FIXTURE_ORIGIN + '/') {
    throw new Error('Browser zoom requires the exact disposable fixture origin')
  }
  const { width, height } = options.viewport
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 320 ||
    height < 320 ||
    width > 4096 ||
    height > 4096
  ) {
    throw new Error('Browser zoom requires a finite supported desktop viewport')
  }
  const storageState = options.useAdminState ? await readFixtureAdminState() : undefined
  const ownedRoot = await mkdtemp(join(tmpdir(), 'quackback-browser-zoom-'))
  let context: BrowserContext | undefined
  let launchStarted = false
  let result: T | undefined
  let operationFailed = false
  let operationError: unknown
  try {
    await chmod(ownedRoot, 0o700)
    const profilePath = join(ownedRoot, 'profile')
    const extensionPath = join(ownedRoot, 'extension')
    await mkdir(profilePath, { mode: 0o700 })
    await mkdir(extensionPath, { mode: 0o700 })
    await writeFile(
      join(extensionPath, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Quackback disposable fixture zoom',
        version: '1.0.0',
        host_permissions: [FIXTURE_ORIGIN + '/*'],
        background: { service_worker: 'zoom-worker.js' },
      }),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    await writeFile(
      join(extensionPath, 'zoom-worker.js'),
      'chrome.runtime.onInstalled.addListener(() => {});\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    launchStarted = true
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      baseURL: FIXTURE_ORIGIN,
      viewport: { width, height },
      locale: 'en-US',
      acceptDownloads: false,
      args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath],
    })
    // Page requests cannot leave the single disposable origin. The generated
    // extension has no content script, external code, or network request code.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url())
      if (url.origin === FIXTURE_ORIGIN && !url.username && !url.password) {
        await route.continue()
      } else {
        await route.abort('blockedbyclient')
      }
    })
    await context.routeWebSocket('**/*', (socket) => {
      const url = new URL(socket.url())
      if (url.origin === 'ws://acme.localhost:3000' && !url.username && !url.password) {
        socket.connectToServer()
      } else {
        socket.close({ code: 1008, reason: 'Disposable fixture origin only' })
      }
    })
    if (storageState) await context.setStorageState(storageState)
    const workerPattern = /^chrome-extension:\/\/[a-p]{32}\/zoom-worker\.js$/
    const existingWorkers = context
      .serviceWorkers()
      .filter((worker) => workerPattern.test(worker.url()))
    if (existingWorkers.length > 1) throw new Error('Ambiguous zoom extension worker')
    const worker =
      existingWorkers[0] ??
      (await context.waitForEvent('serviceworker', {
        predicate: (candidate) => workerPattern.test(candidate.url()),
        timeout: 15_000,
      }))
    const pages = context.pages()
    if (pages.length > 1) throw new Error('Zoom fixture must own exactly one page')
    const page = pages[0] ?? (await context.newPage())
    const ownedContext = context
    let boundTabId: number | undefined
    let settingZoom = false
    const setZoom = async (factor: RequiredBrowserZoom): Promise<ZoomEvidence> => {
      if (factor !== 2 && factor !== 4) throw new Error('A02 requires browser zoom 2 or 4')
      if (settingZoom) throw new Error('Concurrent zoom operations cannot share an evidence page')
      settingZoom = true
      try {
        const url = page.url()
        const target = new URL(url)
        if (
          target.origin !== FIXTURE_ORIGIN ||
          target.username ||
          target.password ||
          page.isClosed() ||
          ownedContext.pages().length !== 1 ||
          ownedContext.pages()[0] !== page
        ) {
          throw new Error(
            'Navigate the sole owned zoom page to the disposable fixture before zooming'
          )
        }
        const applied = await worker.evaluate(
          async ({ origin, url, boundTabId, factor }) => {
            const tabs = (globalThis as unknown as { chrome: { tabs: ExtensionTabs } }).chrome.tabs
            const matches = await tabs.query({ url: origin + '/*' })
            if (
              matches.length !== 1 ||
              matches[0].url !== url ||
              !Number.isInteger(matches[0].id) ||
              (boundTabId !== undefined && matches[0].id !== boundTabId)
            ) {
              throw new Error('The exact owned fixture tab could not be uniquely bound')
            }
            const tabId = matches[0].id!
            await tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-tab' })
            await tabs.setZoom(tabId, factor)
            const settings = await tabs.getZoomSettings(tabId)
            const actual = await tabs.getZoom(tabId)
            const finalTab = await tabs.get(tabId)
            if (
              settings.mode !== 'automatic' ||
              settings.scope !== 'per-tab' ||
              typeof actual !== 'number' ||
              !Number.isFinite(actual) ||
              Math.abs(actual - factor) > 0.001 ||
              finalTab.url !== url
            ) {
              throw new Error('Browser zoom settings or tab identity changed during the operation')
            }
            return { tabId }
          },
          { origin: FIXTURE_ORIGIN, url, boundTabId, factor }
        )
        boundTabId = applied.tabId
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            })
        )
        if (page.url() !== url) throw new Error('Navigation invalidated the browser zoom evidence')
        // Extension API success is not acceptance. Require the independent CDP
        // browser-zoom measurement; callers repeat it after their exercise.
        return await assertActualBrowserZoom(page, factor)
      } finally {
        settingZoom = false
      }
    }
    result = await use({ context, page, setZoom })
  } catch (error) {
    operationFailed = true
    operationError = error
  }

  let cleanupError: Error | undefined
  if (context) {
    try {
      await context.close()
    } catch {
      cleanupError = new Error(
        'Zoom browser shutdown is unconfirmed; retain owned profile: ' + ownedRoot
      )
    }
  } else if (launchStarted) {
    cleanupError = new Error(
      'Zoom launch did not return a closeable context; retain owned profile: ' + ownedRoot
    )
  }
  if (!cleanupError) {
    try {
      await rm(ownedRoot, { recursive: true, force: false })
    } catch {
      cleanupError = new Error(
        'Closed zoom fixture could not remove its owned directory: ' + ownedRoot
      )
    }
  }
  if (operationFailed && cleanupError) {
    throw new AggregateError([operationError, cleanupError], 'Zoom fixture and cleanup both failed')
  }
  if (operationFailed) throw operationError
  if (cleanupError) throw cleanupError
  return result as T
}
