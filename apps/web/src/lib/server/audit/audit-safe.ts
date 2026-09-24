/**
 * Best-effort audit writes for mutation paths.
 *
 * `recordAuditEvent` already swallows insert failures; this wrapper also
 * isolates the caller from the audit module itself (and from reading request
 * headers outside a request), so adding an audit row can never break the
 * mutation it describes. Used by the coverage added for landing-page#2309:
 * boards, post status, status definitions, settings, API keys and webhooks.
 */

import type { AuditActor, AuditActorType, RecordAuditEventInput } from './log'

/**
 * Actor fields for a signed-in session (a requireAuth result). Tolerates a
 * partial context so an audit row can never throw in the mutation path.
 */
export function sessionAuditActor(
  auth:
    | {
        user?: { id?: string | null; email?: string | null } | null
        principal?: { role?: string | null; type?: string | null } | null
      }
    | null
    | undefined
): AuditActor {
  return {
    userId: (auth?.user?.id ?? null) as AuditActor['userId'],
    email: auth?.user?.email ?? null,
    role: auth?.principal?.role ?? null,
    type: (auth?.principal?.type ?? null) as AuditActorType | null,
    authMethod: 'session',
  }
}

/**
 * Actor fields and metadata for an API-key call (a withApiKeyAuth result).
 * Tolerates a partial context, like sessionAuditActor.
 */
export function apiKeyAuditContext(
  auth:
    | {
        principalId?: string | null
        role?: string | null
        apiKey?: { id?: string | null; name?: string | null } | null
      }
    | null
    | undefined
): { actor: AuditActor; metadata: Record<string, unknown> } {
  return {
    actor: {
      userId: null,
      email: null,
      role: auth?.role ?? null,
      type: 'api_key',
      authMethod: 'api_key',
    },
    metadata: {
      apiKeyId: auth?.apiKey?.id ?? null,
      apiKeyName: auth?.apiKey?.name ?? null,
      principalId: auth?.principalId ?? null,
    },
  }
}

/**
 * Record an audit event without ever failing the caller. `headers` is either
 * the request's headers or `'request'` to read them from the server-function
 * request context (skipped outside a request).
 */
export async function recordAuditSafely(
  input: Omit<RecordAuditEventInput, 'headers'>,
  headers?: Headers | 'request'
): Promise<void> {
  let resolved: Headers | undefined
  if (headers === 'request') {
    try {
      const { getRequestHeaders } = await import('@tanstack/react-start/server')
      resolved = getRequestHeaders()
    } catch {
      resolved = undefined
    }
  } else {
    resolved = headers
  }
  try {
    const { recordAuditEvent } = await import('./log')
    await recordAuditEvent({ ...input, headers: resolved })
  } catch {
    // Best effort, like recordAuditEvent itself: never fail the mutation.
  }
}

/** recordAuditSafely for a REST call made with an API key. */
export async function recordApiKeyAuditSafely(
  auth: Parameters<typeof apiKeyAuditContext>[0],
  input: Omit<RecordAuditEventInput, 'headers' | 'actor'>,
  headers?: Headers
): Promise<void> {
  const { actor, metadata } = apiKeyAuditContext(auth)
  await recordAuditSafely(
    { ...input, actor, metadata: { ...metadata, ...(input.metadata ?? {}) } },
    headers
  )
}
