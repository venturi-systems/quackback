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
   * API scopes the key is limited to. Null for a key created before scopes
   * existed: it keeps full API access, bounded by its role and its creator's
   * current role. Internal capability scopes are never listed here.
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
