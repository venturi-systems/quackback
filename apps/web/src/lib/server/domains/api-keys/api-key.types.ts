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
  expiresAt?: Date | null
  /** API scopes for the key. Omitted only by internal callers. */
  scopes?: ApiKeyScope[]
}

export interface CreateApiKeyResult {
  apiKey: ApiKey
  /** The full API key - only returned on creation, never stored */
  plainTextKey: string
}
