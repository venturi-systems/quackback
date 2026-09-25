/**
 * API Keys schema for public API authentication
 *
 * API keys are created by admins and used by external integrations
 * to authenticate with the public REST API.
 */
import { pgTable, timestamp, varchar, index, text } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { typeIdWithDefault, typeIdColumn, typeIdColumnNullable } from '@quackback/ids/drizzle'
import { principal } from './auth'

/**
 * API Keys table
 *
 * Stores hashed API keys for authentication.
 * The actual key is only shown once on creation.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: typeIdWithDefault('api_key')('id').primaryKey(),
    /** Human-readable name for the key */
    name: varchar('name', { length: 255 }).notNull(),
    /** SHA-256 hash of the API key (64 hex chars) */
    keyHash: varchar('key_hash', { length: 64 }).notNull().unique(),
    /** First 12 characters of the key for identification (e.g., "qb_a1b2c3d4") */
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    /** Principal who created this key (nullable — key survives if creator leaves) */
    createdById: typeIdColumnNullable('principal')('created_by_id').references(() => principal.id, {
      onDelete: 'set null',
    }),
    /** Service principal representing this API key's identity */
    principalId: typeIdColumn('principal')('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    /** Last time the key was used for authentication */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /** Expiration date. Every key has one (landing-page#2309, DEF-15). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** When the key was created */
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** When the key was revoked (soft delete) */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * JSON-encoded array of scopes: the key's API scopes (`read:feedback`,
     * `write:feedback`, ...; lib/shared/api-key-scopes.ts), plus any internal
     * capability scope a trusted internal endpoint checks, e.g.
     * `["internal:tier-limits"]`. Venturi fork (landing-page#2309, DEF-15):
     * every new key stores at least one API scope; a key stored without any
     * reads only (LEGACY_API_KEY_SCOPES), never full access.
     */
    scopes: text('scopes'),
    /**
     * Venturi fork (landing-page#2309, DEF-15): when migration
     * 9003_venturi_legacy_api_key_bounds bounded this key because it was
     * created before every key needed scopes and an expiry. Null for every
     * other key.
     */
    legacyBoundedAt: timestamp('legacy_bounded_at', { withTimezone: true }),
  },
  (table) => [
    // Index for listing keys by creator
    index('api_keys_created_by_id_idx').on(table.createdById),
    // Index for looking up the key's service principal
    index('api_keys_principal_id_idx').on(table.principalId),
    // Index for filtering active/revoked keys
    index('api_keys_revoked_at_idx').on(table.revokedAt),
  ]
)

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  createdBy: one(principal, {
    fields: [apiKeys.createdById],
    references: [principal.id],
    relationName: 'apiKeyCreator',
  }),
  principal: one(principal, {
    fields: [apiKeys.principalId],
    references: [principal.id],
    relationName: 'apiKeyPrincipal',
  }),
}))
