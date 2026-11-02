import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

const migration = readFileSync(
  new URL('../../drizzle/9005_venturi_oauth_provider_1_7.sql', import.meta.url),
  'utf8'
)
  .split('--> statement-breakpoint')
  .filter((statement) => statement.trim())
const resourceBackfill = readFileSync(
  new URL('../../sql/oauth-provider-1-7-resource-backfill.sql', import.meta.url),
  'utf8'
)
const databaseUrl = process.env.DATABASE_URL
const client = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null
afterAll(async () => {
  await client?.end()
})

describe.skipIf(!client)('published OAuth provider 1.7 migration', () => {
  it('preserves legacy identities, supports new state, rejects invalid links and is replay safe', async () => {
    if (!client) throw new Error('DATABASE_URL required')
    const schema = 'oauth_17_' + randomUUID().replaceAll('-', '')
    const rollback = new Error('rollback isolated migration fixture')
    await expect(
      client.begin(async (tx) => {
        await tx.unsafe(`CREATE SCHEMA "${schema}"`)
        // Only transaction-owned fixture tables are used; public data is never read or changed.
        await tx.unsafe(`SET LOCAL search_path TO "${schema}"`)
        await tx.unsafe(`
        CREATE TABLE oauth_client (
          id text PRIMARY KEY, client_id text NOT NULL UNIQUE, client_secret text,
          token_endpoint_auth_method text, public boolean, type text, metadata jsonb
        );
        CREATE TABLE oauth_refresh_token (
          id text PRIMARY KEY, token text UNIQUE, revoked timestamptz, scopes text[]
        );
        CREATE TABLE oauth_access_token (id text PRIMARY KEY, token text UNIQUE, scopes text[]);
        CREATE TABLE oauth_consent (id text PRIMARY KEY, scopes text[]);
        CREATE TABLE jwks (id text PRIMARY KEY, public_key text NOT NULL, private_key text NOT NULL);
        INSERT INTO jwks VALUES ('legacy-key', 'synthetic-public-key', 'synthetic-private-key');
        INSERT INTO oauth_client VALUES
          ('public', 'public-client', NULL, NULL, true, 'native', '{"original":true}'),
          ('spa', 'spa-client', NULL, 'none', true, 'user-agent-based', NULL),
          ('private', 'private-client', 'synthetic-hash', 'client_secret_post', false, 'web', NULL),
          ('unknown', 'unknown-client', NULL, NULL, NULL, NULL, NULL),
          ('explicit', 'explicit-client', 'synthetic-hash', 'client_secret_basic', true, 'custom', NULL);
        INSERT INTO oauth_refresh_token VALUES
          ('r', 'synthetic-refresh-hash', '2026-01-01T00:00:00Z', ARRAY['read:feedback']);
        INSERT INTO oauth_access_token VALUES ('a', 'synthetic-access-hash', ARRAY['read:feedback']);
        INSERT INTO oauth_consent VALUES ('c', ARRAY['read:feedback']);
      `)
        const before = await tx.unsafe('SELECT to_jsonb(t) AS row FROM oauth_client t ORDER BY id')
        for (const statement of migration) await tx.unsafe(statement)

        const migrated = await tx.unsafe('SELECT * FROM oauth_client ORDER BY id')
        for (const original of before) {
          const expected = { ...original.row }
          if (expected.id === 'public') expected.token_endpoint_auth_method = 'none'
          expect(migrated.find((row) => row.id === expected.id)).toMatchObject(expected)
        }
        expect(migrated.find((row) => row.id === 'public')?.application_type).toBe('native')
        expect(migrated.find((row) => row.id === 'spa')?.application_type).toBe('web')
        expect(migrated.find((row) => row.id === 'private')?.application_type).toBe('web')
        expect(migrated.find((row) => row.id === 'unknown')?.application_type).toBeNull()
        expect(migrated.find((row) => row.id === 'explicit')?.token_endpoint_auth_method).toBe(
          'client_secret_basic'
        )
        expect(migrated.find((row) => row.id === 'unknown')?.token_endpoint_auth_method).toBeNull()
        expect(migrated.every((row) => row.dpop_bound_access_tokens === false)).toBe(true)
        expect(migrated.every((row) => row.client_credentials_scopes.length === 0)).toBe(true)
        const keys = await tx.unsafe('SELECT * FROM jwks')
        expect(keys[0]).toEqual({
          id: 'legacy-key',
          public_key: 'synthetic-public-key',
          private_key: 'synthetic-private-key',
          alg: null,
          crv: null,
        })
        const refresh = await tx.unsafe('SELECT * FROM oauth_refresh_token')
        expect(refresh[0]).toMatchObject({
          id: 'r',
          token: 'synthetic-refresh-hash',
          scopes: ['read:feedback'],
        })
        expect(refresh[0]?.revoked.toISOString()).toBe('2026-01-01T00:00:00.000Z')
        expect(refresh[0]?.rotated_at).toBeNull()

        await tx`SELECT set_config('quackback.previous_mcp_resource', 'https://fixture.invalid/api/mcp', true)`
        await expect(
          tx.savepoint(async (sp) => {
            await sp.unsafe(resourceBackfill)
          })
        ).rejects.toThrow('Resolve ambiguous legacy OAuth client metadata')
        expect(await tx.unsafe('SELECT * FROM oauth_resource')).toHaveLength(0)
        expect(await tx.unsafe('SELECT * FROM oauth_client_resource')).toHaveLength(0)

        // Simulate explicit operator classification, never an automatic guess by migration.
        await tx.unsafe(`
        UPDATE oauth_client SET application_type = 'web', token_endpoint_auth_method = 'none',
          public = true WHERE id = 'unknown';
        UPDATE oauth_client SET application_type = 'web', public = false WHERE id = 'explicit';
      `)
        await tx.unsafe(resourceBackfill)
        const links = [
          ...(await tx.unsafe('SELECT * FROM oauth_client_resource ORDER BY client_id')),
        ]
        expect(links).toHaveLength(5)
        await tx.unsafe(resourceBackfill)
        expect([
          ...(await tx.unsafe('SELECT * FROM oauth_client_resource ORDER BY client_id')),
        ]).toEqual(links)
        await expect(
          tx.savepoint(async (sp) => {
            await sp.unsafe('UPDATE oauth_resource SET disabled = true')
            await sp.unsafe(resourceBackfill)
          })
        ).rejects.toThrow('The previous MCP resource is disabled')
        await expect(
          tx.savepoint(async (sp) => {
            await sp`SELECT set_config('quackback.previous_mcp_resource', 'http://wrong.invalid/api/mcp', true)`
            await sp.unsafe(resourceBackfill)
          })
        ).rejects.toThrow('Set the exact previous HTTPS MCP audience')

        await tx.unsafe(`
        INSERT INTO oauth_client_assertion(id, expires_at)
          VALUES ('used-jti', '2027-01-01T00:00:00Z');
        UPDATE oauth_refresh_token SET authorization_code_id = 'code', resources = ARRAY['https://fixture.invalid/api/mcp'],
          requested_user_info_claims = ARRAY['email'], rotated_at = '2026-11-01T00:00:00Z',
          rotation_replay_response = 'synthetic-encrypted-response',
          rotation_replay_expires_at = '2026-11-01T00:00:30Z', confirmation = '{"jkt":"fixture"}';
        UPDATE oauth_access_token SET authorization_code_id = 'code', resources = ARRAY['https://fixture.invalid/api/mcp'],
          requested_user_info_claims = ARRAY['email'], revoked = '2026-11-01T00:00:00Z', confirmation = '{"jkt":"fixture"}';
        UPDATE oauth_consent SET resources = ARRAY['https://fixture.invalid/api/mcp'],
          requested_user_info_claims = ARRAY['email'];
      `)
        const tables = [
          'oauth_client',
          'oauth_refresh_token',
          'oauth_access_token',
          'oauth_consent',
          'oauth_resource',
          'oauth_client_resource',
          'oauth_client_assertion',
          'jwks',
        ]
        async function snapshot() {
          const rows: Record<string, unknown> = {}
          for (const table of tables) {
            rows[table] = [
              ...(await tx.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY id`)),
            ]
          }
          return rows
        }
        const first = await snapshot()
        for (const statement of migration) await tx.unsafe(statement)
        expect(await snapshot()).toEqual(first)

        await expect(
          tx.savepoint(async (sp) => {
            await sp.unsafe(
              "INSERT INTO oauth_client_resource VALUES ('duplicate','public-client','https://fixture.invalid/api/mcp',NULL,NULL)"
            )
          })
        ).rejects.toMatchObject({ code: '23505' })
        await expect(
          tx.savepoint(async (sp) => {
            await sp.unsafe(
              "INSERT INTO oauth_client_resource VALUES ('missing','missing-client','https://fixture.invalid/api/mcp',NULL,NULL)"
            )
          })
        ).rejects.toMatchObject({ code: '23503' })
        await expect(
          tx.savepoint(async (sp) => {
            await sp.unsafe(
              "INSERT INTO oauth_client_assertion VALUES ('used-jti','2028-01-01T00:00:00Z')"
            )
          })
        ).rejects.toMatchObject({ code: '23505' })
        await tx.unsafe(
          "DELETE FROM oauth_resource WHERE identifier='https://fixture.invalid/api/mcp'"
        )
        expect(await tx.unsafe('SELECT * FROM oauth_client_resource')).toHaveLength(0)
        expect(await tx.unsafe('SELECT * FROM oauth_client')).toHaveLength(5)
        throw rollback
      })
    ).rejects.toBe(rollback)
  })
})
