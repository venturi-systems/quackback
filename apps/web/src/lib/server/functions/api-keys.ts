/**
 * Server functions for API key operations
 */

import { z } from 'zod'
import { createServerFn } from '@tanstack/react-start'
import { requireAuth } from './auth-helpers'
import { ValidationError } from '@/lib/shared/errors'
import type { ApiKeyId } from '@/lib/server/domains/api-keys/api-key.service'
import { logger } from '@/lib/server/logger'
import { recordAuditSafely, sessionAuditActor } from '@/lib/server/audit/audit-safe'
import { API_KEY_MAX_EXPIRY_DAYS, API_KEY_SCOPES } from '@/lib/shared/api-key-scopes'

const log = logger.child({ component: 'api-keys' })

// ============================================
// Schemas
// ============================================

const createApiKeySchema = z.object({
  name: z.string().min(1, 'Name is required').max(255, 'Name must be 255 characters or less'),
  // Every new key is scoped and expires (landing-page#2309): a key's scopes
  // bound what it may do, and its expiry bounds how long a leaked key works.
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, 'Choose at least one scope'),
  expiresAt: z.string().datetime(),
})

const getApiKeySchema = z.object({
  id: z.string(),
})

const updateApiKeySchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(255),
})

const rotateApiKeySchema = z.object({
  id: z.string(),
})

const revokeApiKeySchema = z.object({
  id: z.string(),
})

/** The key fields an audit row records: never the key or its hash. */
function keyAuditView(key: {
  name: string
  keyPrefix: string
  scopes: readonly string[] | null
  expiresAt: Date | null
}) {
  return {
    name: key.name,
    keyPrefix: key.keyPrefix,
    // A key stored without API scopes works read-only (LEGACY_API_KEY_SCOPES).
    scopes: key.scopes ?? 'legacy-read-only',
    expiresAt: key.expiresAt ? new Date(key.expiresAt).toISOString() : null,
  }
}

/** Slack for clock skew between the browser that computed the expiry and the server. */
const EXPIRY_SKEW_MS = 24 * 60 * 60 * 1000

/**
 * A new key must expire in the future and within API_KEY_MAX_EXPIRY_DAYS.
 * Exported for tests.
 */
export function assertApiKeyExpiry(expiresAt: Date, now: number = Date.now()): void {
  const max = now + API_KEY_MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000 + EXPIRY_SKEW_MS
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now) {
    throw new ValidationError('VALIDATION_ERROR', 'An API key must expire in the future')
  }
  if (expiresAt.getTime() > max) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      `An API key can live at most ${API_KEY_MAX_EXPIRY_DAYS} days`
    )
  }
}

// ============================================
// Type Exports
// ============================================

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>
export type GetApiKeyInput = z.infer<typeof getApiKeySchema>
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>
export type RotateApiKeyInput = z.infer<typeof rotateApiKeySchema>
export type RevokeApiKeyInput = z.infer<typeof revokeApiKeySchema>

// ============================================
// Read Operations
// ============================================

/**
 * List all active API keys
 */
export const fetchApiKeys = createServerFn({ method: 'GET' }).handler(async () => {
  log.debug('list api keys')
  try {
    // Only admins can manage API keys
    await requireAuth({ roles: ['admin'] })

    const { listApiKeys } = await import('@/lib/server/domains/api-keys/api-key.service')
    const keys = await listApiKeys()
    log.debug({ count: keys.length }, 'api keys fetched')
    return keys
  } catch (error) {
    log.error({ err: error }, 'list api keys failed')
    throw error
  }
})

/**
 * Get a single API key by ID
 */
export const fetchApiKey = createServerFn({ method: 'GET' })
  .validator(getApiKeySchema)
  .handler(async ({ data }) => {
    log.debug({ api_key_id: data.id }, 'get api key')
    try {
      await requireAuth({ roles: ['admin'] })

      const { getApiKeyById } = await import('@/lib/server/domains/api-keys/api-key.service')
      const key = await getApiKeyById(data.id as ApiKeyId)
      log.debug({ found: !!key }, 'api key lookup')
      return key
    } catch (error) {
      log.error({ err: error }, 'get api key failed')
      throw error
    }
  })

// ============================================
// Write Operations
// ============================================

/**
 * Create a new API key
 * Returns the full key only once - store it securely!
 */
export const createApiKeyFn = createServerFn({ method: 'POST' })
  .validator(createApiKeySchema)
  .handler(async ({ data }) => {
    log.debug({ name: data.name }, 'create api key')
    try {
      const auth = await requireAuth({ roles: ['admin'] })

      const expiresAt = new Date(data.expiresAt)
      assertApiKeyExpiry(expiresAt)

      const { createApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      const result = await createApiKey(
        { name: data.name, scopes: data.scopes, expiresAt },
        auth.principal.id
      )
      log.info({ api_key_id: result.apiKey.id }, 'api key created')
      await recordAuditSafely(
        {
          event: 'api_key.created',
          actor: sessionAuditActor(auth),
          target: { type: 'api_key', id: result.apiKey.id },
          after: keyAuditView(result.apiKey),
        },
        'request'
      )
      return result
    } catch (error) {
      log.error({ err: error }, 'create api key failed')
      throw error
    }
  })

/**
 * Update an API key's name
 */
export const updateApiKeyFn = createServerFn({ method: 'POST' })
  .validator(updateApiKeySchema)
  .handler(async ({ data }) => {
    log.debug({ api_key_id: data.id }, 'update api key')
    try {
      const auth = await requireAuth({ roles: ['admin'] })

      const { updateApiKeyName, getApiKeyById } =
        await import('@/lib/server/domains/api-keys/api-key.service')
      const before = await getApiKeyById(data.id as ApiKeyId).catch(() => null)
      const key = await updateApiKeyName(data.id as ApiKeyId, data.name)
      log.info({ api_key_id: key.id }, 'api key updated')
      await recordAuditSafely(
        {
          event: 'api_key.renamed',
          actor: sessionAuditActor(auth),
          target: { type: 'api_key', id: key.id },
          before: before ? { name: before.name } : null,
          after: { name: key.name },
        },
        'request'
      )
      return key
    } catch (error) {
      log.error({ err: error }, 'update api key failed')
      throw error
    }
  })

/**
 * Rotate an API key - generates a new key
 * Returns the new full key only once - store it securely!
 */
export const rotateApiKeyFn = createServerFn({ method: 'POST' })
  .validator(rotateApiKeySchema)
  .handler(async ({ data }) => {
    log.debug({ api_key_id: data.id }, 'rotate api key')
    try {
      const auth = await requireAuth({ roles: ['admin'] })

      const { rotateApiKey } = await import('@/lib/server/domains/api-keys/api-key.service')
      const result = await rotateApiKey(data.id as ApiKeyId)
      log.info({ api_key_id: result.apiKey.id }, 'api key rotated')
      await recordAuditSafely(
        {
          event: 'api_key.rotated',
          actor: sessionAuditActor(auth),
          target: { type: 'api_key', id: result.apiKey.id },
          after: keyAuditView(result.apiKey),
        },
        'request'
      )
      return result
    } catch (error) {
      log.error({ err: error }, 'rotate api key failed')
      throw error
    }
  })

/**
 * Revoke an API key (soft delete)
 */
export const revokeApiKeyFn = createServerFn({ method: 'POST' })
  .validator(revokeApiKeySchema)
  .handler(async ({ data }) => {
    log.debug({ api_key_id: data.id }, 'revoke api key')
    try {
      const auth = await requireAuth({ roles: ['admin'] })

      const { revokeApiKey, getApiKeyById } =
        await import('@/lib/server/domains/api-keys/api-key.service')
      const before = await getApiKeyById(data.id as ApiKeyId).catch(() => null)
      await revokeApiKey(data.id as ApiKeyId)
      log.info({ api_key_id: data.id }, 'api key revoked')
      await recordAuditSafely(
        {
          event: 'api_key.revoked',
          actor: sessionAuditActor(auth),
          target: { type: 'api_key', id: data.id },
          before: before ? keyAuditView(before) : null,
        },
        'request'
      )
      return { id: data.id as ApiKeyId }
    } catch (error) {
      log.error({ err: error }, 'revoke api key failed')
      throw error
    }
  })
