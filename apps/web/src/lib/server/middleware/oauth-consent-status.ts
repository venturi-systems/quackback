/**
 * The HTTP status of an incomplete OAuth consent request.
 *
 * `/oauth/consent` without a usable `client_id` names no application, so the
 * page renders "This authorization request is incomplete" instead of a
 * consent form (routes/oauth/consent.tsx). The response still said 200, so a
 * client or monitor reading the status saw success. The server entry
 * (src/server.ts) keeps the page and answers it with 400 Bad Request.
 */

/**
 * The client id the consent page will read from a raw query value, or
 * undefined when it reads none. It mirrors the page: the router parses each
 * query value as JSON when it can (`123` is the number 123), the page's search
 * schema keeps only text, numbers and booleans, and an empty value names no
 * application.
 */
export function consentClientId(raw: string | null): string | undefined {
  if (raw === null) return undefined
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    // Plain text, as typed.
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value)
    return text === '' ? undefined : text
  }
  return undefined
}

/** A GET or HEAD for the consent page that names no application. */
export function isIncompleteConsentRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return false
  }
  if (url.pathname !== '/oauth/consent' && url.pathname !== '/oauth/consent/') return false
  return consentClientId(url.searchParams.get('client_id')) === undefined
}

/**
 * The same page with status 400. Only a 200 is changed: a redirect (for
 * example to sign in) or an error keeps its own status.
 */
export function asBadRequest(response: Response): Response {
  if (response.status !== 200) return response
  return new Response(response.body, {
    status: 400,
    statusText: 'Bad Request',
    headers: response.headers,
  })
}
