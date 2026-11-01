// @vitest-environment node
import { afterAll, describe, expect, it, vi } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
// This transaction-owned fixture needs canonical relations without loading the
// application DB proxy that this test deliberately wraps below.
// eslint-disable-next-line no-restricted-imports
import * as databaseSchema from '@quackback/db/schema'
import { getTableColumns, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

const state = vi.hoisted(() => ({ transaction: undefined as unknown }))
const databaseUrl = process.env.QUACKBACK_AUTH_TEST_DATABASE_URL
const baseUrl = 'https://quackback-auth-startup.invalid'
const rollback = new Error('ROLLBACK_AUTH_STARTUP_FIXTURE')

vi.mock('@/lib/server/config', () => ({
  config: {
    get databaseUrl() {
      return process.env.QUACKBACK_AUTH_TEST_DATABASE_URL
    },
    baseUrl: 'https://quackback-auth-startup.invalid',
    secretKey: 'isolated-auth-startup-test-secret-0123456789abcdef',
    oauthRefreshGraceSeconds: 60,
  },
}))
vi.mock('@/lib/server/db', async (original) => {
  const actual = await original<typeof import('@/lib/server/db')>()
  return {
    ...actual,
    db: new Proxy(
      {},
      {
        get(_target, key) {
          if (!state.transaction)
            throw new Error('Auth startup DB accessed outside fixture transaction')
          return Reflect.get(state.transaction as object, key)
        },
      }
    ),
  }
})
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: async () => ({ features: { customOidcProvider: true } }),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getTenantSettings: async () => ({
    settings: { authConfigVersion: 0 },
    authConfig: { oauth: {} },
  }),
}))
vi.mock('@/lib/server/domains/settings/identity-providers.service', () => ({
  listIdentityProviders: async () => [],
  getIdentityProviderCredentials: async () => null,
}))
vi.mock('@/lib/server/domains/platform-credentials/platform-credential.service', () => ({
  getPlatformCredentials: async () => null,
}))

const ownedClient = databaseUrl ? postgres(databaseUrl, { max: 1 }) : undefined
const fixture = ownedClient ? drizzle(ownedClient, { schema: databaseSchema }) : undefined
const { auth: applicationAuth, getAuth, resetAuth } = await import('../index')
afterAll(async () => {
  resetAuth()
  await ownedClient?.end()
})

describe.skipIf(!databaseUrl)(
  'production auth startup with the actual application schema barrel',
  () => {
    it('initializes the real factory and persists all new provider models through Drizzle', async () => {
      const url = new URL(databaseUrl!)
      const isolatedLocalFixture =
        url.hostname === '127.0.0.1' && url.port !== '' && url.port !== '5432'
      // CI opts in only beside its disposable PostgreSQL service. A generic
      // CI environment or a different database name never authorizes 5432.
      const disposableCiFixture =
        process.env.CI === 'true' &&
        process.env.QUACKBACK_AUTH_CI_FIXTURE === 'true' &&
        ['localhost', '127.0.0.1'].includes(url.hostname) &&
        url.port === '5432' &&
        url.pathname === '/quackback_test'
      if (!isolatedLocalFixture && !disposableCiFixture)
        throw new Error('Requires an explicitly isolated local or disposable CI fixture')
      await expect(
        fixture!.transaction(async (transaction) => {
          state.transaction = transaction
          resetAuth()
          const auth = await getAuth()
          const context = await auth.$context
          const applicationSchema: Record<string, unknown> = await import('@/lib/server/db')
          for (const [model, schema] of Object.entries(context.tables)) {
            const modelName = schema.modelName ?? model
            const table = applicationSchema[modelName]
            expect(is(table, PgTable), `Application barrel must export model ${modelName}`).toBe(
              true
            )
            if (!is(table, PgTable)) throw new Error(`Missing application model ${modelName}`)
            const columns = getTableColumns(table)
            for (const [field, definition] of Object.entries(schema.fields)) {
              expect(
                columns,
                `${modelName}.${field} must exist for the configured auth plugin`
              ).toHaveProperty(definition.fieldName ?? field)
            }
          }
          const jwksResponse = await applicationAuth.handler(
            new Request(`${baseUrl}/api/auth/jwks`)
          )
          expect(jwksResponse.status).toBe(200)
          expect((await jwksResponse.json()).keys.length).toBeGreaterThan(0)
          const resource = await context.adapter.findOne({
            model: 'oauthResource',
            where: [{ field: 'identifier', value: `${baseUrl}/api/mcp` }],
          })
          expect(resource).toMatchObject({ identifier: `${baseUrl}/api/mcp` })
          const client = await context.adapter.create({
            model: 'oauthClient',
            data: {
              clientId: 'startup-regression-client',
              clientCredentialsScopes: [],
              tokenEndpointAuthMethod: 'none',
              redirectUris: ['https://client.example/callback'],
              applicationType: 'native',
            },
          })
          const link = await context.adapter.create({
            model: 'oauthClientResource',
            data: { clientId: client.clientId, resourceId: `${baseUrl}/api/mcp` },
          })
          expect(link).toMatchObject({
            clientId: 'startup-regression-client',
            resourceId: `${baseUrl}/api/mcp`,
          })
          const assertion = await context.adapter.create({
            model: 'oauthClientAssertion',
            data: { expiresAt: new Date(Date.now() + 60_000) },
          })
          expect(assertion.id).toBeTruthy()
          throw rollback
        })
      ).rejects.toBe(rollback)
      state.transaction = undefined
      resetAuth()
    })
  }
)
