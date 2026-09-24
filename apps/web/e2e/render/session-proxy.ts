/**
 * A loopback reverse proxy that adds one fixture identity's session cookie to
 * every request it forwards to the app.
 *
 * WHY. The design suite checker (design-suite/scripts/text-quality-check.mjs)
 * opens every URL in a fresh browser context with no cookies, and it must run
 * unmodified. It can therefore only ever see a signed-out page. Pointing it at
 * this proxy instead of the app lets it render the signed-in page without a
 * single byte of the checker changing: the browser talks to the proxy, and the
 * proxy talks to the app as the signed-in identity.
 *
 * WHAT IT CHANGES, AND NOTHING ELSE.
 *   - Request: the identity's cookies are merged into the Cookie header (they
 *     replace any same-named cookie the page set); Origin and Referer are
 *     rewritten from the proxy's origin to the app's, so the app's own origin
 *     checks see the origin it trusts; the Host header is the app's; and the
 *     request asks for an uncompressed body.
 *   - Response: a Location header that names the app's origin is rewritten to
 *     the proxy's, so a redirect stays behind the proxy. Content-Encoding and
 *     Content-Length are dropped because the forwarded body is already decoded.
 *
 * The cookies come from a Playwright storage-state file written by the
 * end-to-end fixtures (e2e/global-setup.ts, loginViaMagicLink). They are never
 * printed. The proxy binds 127.0.0.1 only.
 */
import fs from 'node:fs'

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]

interface StorageStateCookie {
  name: string
  value: string
  domain: string
}

export interface SessionProxy {
  origin: string
  stop(): void
}

function cookiesFor(storageStatePath: string, hostname: string): Map<string, string> {
  const state = JSON.parse(fs.readFileSync(storageStatePath, 'utf8')) as {
    cookies?: StorageStateCookie[]
  }
  const jar = new Map<string, string>()
  for (const cookie of state.cookies ?? []) {
    const domain = cookie.domain.replace(/^\./, '')
    if (hostname === domain || hostname.endsWith(`.${domain}`)) jar.set(cookie.name, cookie.value)
  }
  if (jar.size === 0) {
    throw new Error(`${storageStatePath} holds no cookie for ${hostname}`)
  }
  return jar
}

function mergeCookieHeader(existing: string | null, injected: Map<string, string>): string {
  const pairs: string[] = []
  for (const part of (existing ?? '').split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const name = trimmed.split('=', 1)[0]
    if (!injected.has(name)) pairs.push(trimmed)
  }
  for (const [name, value] of injected) pairs.push(`${name}=${value}`)
  return pairs.join('; ')
}

/**
 * Start a proxy for `upstream` (an origin such as http://acme.localhost:3000)
 * on `port`, as the identity stored in `storageStatePath`. The returned origin
 * uses the upstream's hostname with the proxy's port.
 */
export function startSessionProxy(options: {
  port: number
  upstream: string
  storageStatePath: string
  /** Extra origins whose Location headers are rewritten (the app's BASE_URL). */
  alsoRewrite?: string[]
}): SessionProxy {
  const upstream = new URL(options.upstream)
  const jar = cookiesFor(options.storageStatePath, upstream.hostname)
  const origin = `${upstream.protocol}//${upstream.hostname}:${options.port}`
  const upstreamOrigins = [upstream.origin, ...(options.alsoRewrite ?? [])]

  const server = Bun.serve({
    port: options.port,
    hostname: '127.0.0.1',
    idleTimeout: 120,
    async fetch(request) {
      const incoming = new URL(request.url)
      const target = new URL(`${incoming.pathname}${incoming.search}`, upstream)
      const headers = new Headers(request.headers)
      for (const name of HOP_BY_HOP) headers.delete(name)
      headers.set('accept-encoding', 'identity')
      headers.set('cookie', mergeCookieHeader(request.headers.get('cookie'), jar))
      for (const name of ['origin', 'referer']) {
        const value = headers.get(name)
        if (value?.startsWith(origin))
          headers.set(name, upstream.origin + value.slice(origin.length))
      }
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        redirect: 'manual',
      })
      const out = new Headers(response.headers)
      for (const name of [
        'content-encoding',
        'content-length',
        'transfer-encoding',
        'connection',
      ]) {
        out.delete(name)
      }
      const location = out.get('location')
      if (location) {
        for (const from of upstreamOrigins) {
          if (location.startsWith(from)) {
            out.set('location', origin + location.slice(from.length))
            break
          }
        }
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: out,
      })
    },
  })

  return {
    origin,
    stop() {
      server.stop(true)
    },
  }
}
