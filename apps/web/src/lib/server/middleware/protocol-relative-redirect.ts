/**
 * Requests whose path begins with `//`.
 *
 * A path such as `//evil.example` reads as protocol-relative wherever a URL is
 * rebuilt from it, so TanStack Start redirects it to the path with its leading
 * slashes collapsed (@tanstack/start-server-core 1.169.37, `createStartHandler`,
 * via `getNormalizedURL` in @tanstack/router-core 1.171.32). It answers with
 * `Response.redirect(url, 308)`, whose Location is an ABSOLUTE URL built from
 * `request.url`. The TLS-terminating proxy in front of the server forwards
 * plain HTTP, so `request.url` starts with `http://`, and production answered
 * `GET //evil.example` with `308 location: http://feedback.venturi.systems/evil.example`
 * (measured 2026-09-24 23:57Z). The host is the same, but the redirect points
 * at `http://`: HSTS keeps browsers on https, yet the answer itself downgrades
 * the scheme.
 *
 * The server entry (src/server.ts) answers these requests before the framework
 * does, with the same 308 and the same collapsed path, but as a path-absolute
 * relative Location. A client resolves that against the URL it requested, so it
 * keeps the scheme and host it used.
 */

/**
 * The 308 for a request whose parsed path begins with `//`, or null for any
 * other request. The path is read after the URL parser has turned backslashes
 * into slashes and applied dot segments, so `/\evil.example` and
 * `/.//evil.example` are included. The Location is the path with its leading
 * slashes collapsed to one, plus the query unchanged: it always starts with
 * exactly one `/`, so it can never itself be protocol-relative.
 */
export function protocolRelativePathRedirect(request: Request): Response | null {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return null
  }
  if (!url.pathname.startsWith('//')) return null
  const location = url.pathname.replace(/^\/+/, '/') + url.search
  return new Response(null, {
    status: 308,
    headers: { location, 'cache-control': 'no-store' },
  })
}
