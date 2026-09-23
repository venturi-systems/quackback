/**
 * /widget is the embed iframe document. The SDK and /api/widget/config.json
 * already refuse a disabled widget; the document must too, instead of
 * rendering a live-looking feedback shell ("No ideas yet") on a workspace
 * that never enabled the widget. When enabled, the loader still never hands
 * the widget HMAC secret to the page.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  notFoundError: new Error('NOT_FOUND'),
  setIframeHeaders: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (opts: unknown) => ({ options: opts }),
  notFound: () => mocks.notFoundError,
  redirect: (opts: unknown) => ({ redirect: opts }),
  Outlet: () => null,
}))
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = { validator: () => chain, handler: (fn: unknown) => fn }
    return chain
  },
  createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('@tanstack/react-start/server', () => ({
  getRequestHeaders: () => new Headers(),
  setResponseHeader: mocks.setIframeHeaders,
}))
vi.mock('@/components/widget/widget-auth-provider', () => ({ WidgetAuthProvider: () => null }))
vi.mock('@/lib/server/functions/portal-session-token', () => ({
  extractSessionTokenFromCookie: () => null,
}))

import { Route } from '../widget'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoaderFn = (ctx: any) => Promise<{ org: Record<string, unknown> }>
const loader = (Route as unknown as { options: { loader: LoaderFn } }).options.loader

function ctx(widgetEnabled: boolean | undefined) {
  return {
    context: {
      session: null,
      settings: {
        settings: {
          id: 'workspace_1',
          name: 'Acme',
          widgetSecret: 'wgt_secret',
          portalConfig: null,
        },
        brandingData: null,
        brandingConfig: {},
        customCss: '',
        publicWidgetConfig: widgetEnabled === undefined ? undefined : { enabled: widgetEnabled },
      },
    },
    location: { search: {} },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/widget loader', () => {
  it.each([
    ['disabled', false],
    ['unconfigured', undefined],
  ])('404s when the widget is %s', async (_label, enabled) => {
    await expect(loader(ctx(enabled))).rejects.toBe(mocks.notFoundError)
    expect(mocks.setIframeHeaders).not.toHaveBeenCalled()
  })

  it('renders when the widget is enabled, without the widget secret', async () => {
    const data = await loader(ctx(true))
    expect(data.org.name).toBe('Acme')
    expect(data.org).not.toHaveProperty('widgetSecret')
  })
})
