import type { TypeId, PrincipalId } from '@quackback/ids'
import type { ApiKeyScope } from '@/lib/shared/api-key-scopes'

export type ApiKeyId = TypeId<'api_key'>

export interface ApiKey {
  id: ApiKeyId
  name: string
  keyPrefix: string
  createdById: PrincipalId | null
  principalId: PrincipalId
  lastUsedAt: Date | null
  /**
   * The stored expiry. Null for a key created before every key had to expire:
   * that key stops working API_KEY_MAX_EXPIRY_DAYS after `createdAt`
   * (apiKeyExpiresAt in lib/shared/api-key-scopes.ts).
   */
  expiresAt: Date | null
  createdAt: Date
  revokedAt: Date | null
  /**
   * When migration 9003_venturi_legacy_api_key_bounds.sql bounded this key
   * because it was created before every key needed scopes and an expiry: it
   * got read-only scopes (LEGACY_API_KEY_SCOPES) if it had none, and an expiry
   * if it had none or a later one than a new key may have. Null for every
   * other key. The API keys settings page shows it, so an administrator knows
   * to replace the key before it expires.
   */
  legacyBoundedAt: Date | null
  /**
   * API scopes the key is limited to. Null for a key stored without any API
   * scope (created before scopes existed, and not bounded by the migration):
   * it works with LEGACY_API_KEY_SCOPES (read only), never full access, still
   * bounded by its role and its creator's current role
   * (effectiveApiKeyScopes). Internal capability scopes are never listed here.
   */
  scopes: ApiKeyScope[] | null
}

export interface CreateApiKeyInput {
  name: string
  /** Every key expires (landing-page#2309, DEF-15). */
  expiresAt: Date
  /** API scopes for the key: at least one. Every key is scoped. */
  scopes: ApiKeyScope[]
}

export interface CreateApiKeyResult {
  apiKey: ApiKey
  /** The full API key - only returned on creation, never stored */
  plainTextKey: string
}
