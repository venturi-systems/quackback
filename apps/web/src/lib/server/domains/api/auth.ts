/**
 * API Key Authentication Middleware
 *
 * Validates API keys for public REST API endpoints.
 * Used in /api/v1/* routes.
 */

import { verifyApiKey } from '@/lib/server/domains/api-keys/api-key.service'
import type { ApiKey } from '@/lib/server/domains/api-keys'
import { checkRateLimit, getClientIp } from './rate-limit'
import { UnauthorizedError, ForbiddenError, RateLimitError } from '@/lib/shared/errors'
import { db, principal, eq } from '@/lib/server/db'
import type { PrincipalId } from '@quackback/ids'
import { isAdmin, isTeamMember } from '@/lib/shared/roles'
import { API_KEY_SCOPES, hasApiKeyScope, type ApiKeyScope } from '@/lib/shared/api-key-scopes'

export type MemberRole = 'admin' | 'member' | 'user'

export interface ApiAuthContext {
  /** The validated API key */
  apiKey: ApiKey
  /** The key's service principal (for attribution and audit logging) */
  principalId: PrincipalId
  /**
   * The role the key may exercise: its stored role, capped by its creator's
   * current role under the team identity rule (api-key-authority.ts).
   */
  role: MemberRole
  /** Scopes the key carries (every scope for a legacy key created without any). */
  scopes: readonly ApiKeyScope[]
  /** Whether the request is in import mode (suppresses side effects, raises rate limit) */
  importMode: boolean
}

/** Pathname of a request URL, or '' when the URL cannot be parsed. */
function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname
  } catch {
    return ''
  }
}

/**
 * The scope a REST call needs. Administrator-only routes need
 * `admin:workspace`; other routes need the read or write scope of their
 * resource family, by HTTP method.
 */
export function requiredRestScope(request: Request, level: AuthLevel): ApiKeyScope {
  if (level === 'admin') return 'admin:workspace'
  const path = requestPath(request)
  const read = request.method === 'GET' || request.method === 'HEAD'
  if (path.startsWith('/api/v1/help-center')) return read ? 'read:article' : 'write:article'
  if (path.startsWith('/api/v1/conversations')) return read ? 'read:chat' : 'write:chat'
  if (path.startsWith('/api/v1/changelog') && !read) return 'write:changelog'
  return read ? 'read:feedback' : 'write:feedback'
}

/**
 * Status changes email subscribers, so only a signed-in team member makes
 * one. No API key or MCP client can, whatever its scopes (landing-page#2309).
 */
export const STATUS_CHANGE_REFUSAL =
  'Status changes are made by a signed-in team member in the admin inbox. API keys and agents cannot change a status.'

/** Refuse a request body that would set or change a post status. */
export function assertNoStatusChange(statusId: unknown): void {
  if (statusId !== undefined && statusId !== null) {
    throw new ForbiddenError('STATUS_CHANGE_NOT_ALLOWED', STATUS_CHANGE_REFUSAL)
  }
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  return match ? match[1] : null
}

/**
 * Require API key authentication for a request.
 *
 * @param request - The incoming request
 * @returns ApiAuthContext if valid, null if authentication failed
 *
 * @example
 * const auth = await requireApiKey(request)
 * if (!auth) {
 *   return errorResponse('UNAUTHORIZED', 'Invalid or missing API key', 401)
 * }
 */
export async function requireApiKey(request: Request): Promise<ApiAuthContext | null> {
  const authHeader = request.headers.get('authorization')
  const token = extractBearerToken(authHeader)

  if (!token) {
    return null
  }

  const apiKey = await verifyApiKey(token)
  if (!apiKey) {
    return null
  }

  // Use the API key's service principal for role and identity
  const principalRecord = await db.query.principal.findFirst({
    where: eq(principal.id, apiKey.principalId),
    columns: { role: true },
  })

  // The key's stored role, capped by its creator's current role under the
  // team identity rule. A missing principal is the most restrictive role.
  const { resolveApiKeyRole } = await import('@/lib/server/domains/api-keys/api-key-authority')
  const role = await resolveApiKeyRole(apiKey, principalRecord?.role)

  return {
    apiKey,
    principalId: apiKey.principalId,
    role,
    scopes: apiKey.scopes ?? [...API_KEY_SCOPES],
    importMode: false,
  }
}

export type AuthLevel = 'team' | 'admin'

/**
 * Require API key authentication with role-based authorization.
 * Includes rate limiting to prevent brute-force attacks.
 *
 * @param request - The incoming request
 * @param options.role - Required role level: 'team' (admin or member) or 'admin' (admin only)
 *
 * @example
 * const { principalId } = await withApiKeyAuth(request, { role: 'team' })
 */
export async function withApiKeyAuth(
  request: Request,
  options: {
    role: AuthLevel
    /**
     * Scope the call needs. Defaults to the route's resource family and HTTP
     * method (requiredRestScope). `null` means the caller enforces scopes
     * itself, per operation (the MCP handler does, per tool).
     */
    scope?: ApiKeyScope | null
  }
): Promise<ApiAuthContext> {
  const clientIp = getClientIp(request)
  const wantsImportMode = request.headers.get('x-import-mode') === 'true'
  const rateLimit = await checkRateLimit(clientIp, wantsImportMode)

  if (!rateLimit.allowed) {
    throw new RateLimitError(rateLimit.retryAfter ?? 60)
  }

  const auth = await requireApiKey(request)

  if (!auth) {
    throw new UnauthorizedError(
      'Invalid or missing API key. Provide a valid key in the Authorization header: Bearer qb_xxx'
    )
  }

  if (options.role === 'admin' && !isAdmin(auth.role)) {
    throw new ForbiddenError('FORBIDDEN', 'Admin access required for this operation')
  }

  if (options.role === 'team' && !isTeamMember(auth.role)) {
    throw new ForbiddenError('FORBIDDEN', 'Team member access required for this operation')
  }

  const scope =
    options.scope === undefined ? requiredRestScope(request, options.role) : options.scope
  if (scope !== null && !hasApiKeyScope(auth.scopes, scope)) {
    throw new ForbiddenError(
      'INSUFFICIENT_SCOPE',
      `This API key does not carry the ${scope} scope required for this operation`
    )
  }

  if (wantsImportMode && isAdmin(auth.role)) {
    auth.importMode = true
  }

  return auth
}
