/** Forward legacy custom-OIDC callbacks to Better Auth's shared 1.7 route. */
export function forwardLegacyOidcCallback(
  request: Request,
  registeredIds: ReadonlySet<string>
): Request {
  const url = new URL(request.url)
  const match = /^\/api\/auth\/oauth2\/callback\/([^/]+)$/.exec(url.pathname)
  if (!match || !registeredIds.has(match[1])) return request
  url.pathname = `/api/auth/callback/${match[1]}`
  return new Request(url, request)
}
