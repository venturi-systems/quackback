/**
 * REQ-FEEDBACK-AUTH-VIEWPORT: supply real built-in provider buttons in the
 * disposable CI fixture without contacting either OAuth provider. The existing
 * fixture guard proves the database and application belong to this CI job.
 * Stable row IDs let finally cleanup recover an interrupted setup while refusing
 * to replace or remove any pre-existing credential owned by another fixture.
 */
import postgres from 'postgres'
import { encryptPlatformCredentials } from '@/lib/server/integrations/encryption'
import { getRedis, CACHE_KEYS } from '@/lib/server/redis'
import { assertDesignFixtureEnvironment } from '../utils/design-fixture-guard'

const providers = [
  { name: 'google', id: 'c8ecf766-8d5e-42d5-875d-dc76afc5328c' },
  { name: 'github', id: '07a95054-474b-4b02-bcd2-983b2bdeac78' },
] as const
const action = process.argv[2]
let sql: ReturnType<typeof postgres> | undefined
let cacheOpened = false
try {
  if (action !== 'seed' && action !== 'remove') {
    throw new Error('Expected seed or remove')
  }
  // This proof precedes even opening a database connection. A loopback address
  // alone is not ownership evidence, and production cannot satisfy the guard.
  await assertDesignFixtureEnvironment()
  sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  await sql.begin(async (tx) => {
    for (const provider of providers) {
      const integrationType = `auth_${provider.name}`
      if (action === 'seed') {
        const secrets = encryptPlatformCredentials({
          clientId: `e2e-entry-${provider.name}-client`,
          clientSecret: `e2e-entry-${provider.name}-secret`,
        })
        const inserted = await tx`
          INSERT INTO integration_platform_credentials (id, integration_type, secrets)
          VALUES (${provider.id}, ${integrationType}, ${secrets})
          ON CONFLICT (integration_type) DO UPDATE
          SET secrets = EXCLUDED.secrets, updated_at = NOW()
          WHERE integration_platform_credentials.id = ${provider.id}
          RETURNING id`
        if (inserted.length !== 1 || inserted[0].id !== provider.id) {
          throw new Error('Provider credential is not owned by this fixture')
        }
      } else {
        await tx`DELETE FROM integration_platform_credentials
          WHERE id = ${provider.id} AND integration_type = ${integrationType}`
        const remaining = await tx`SELECT id FROM integration_platform_credentials
          WHERE id = ${provider.id} AND integration_type = ${integrationType}`
        if (remaining.length !== 0) throw new Error('Owned provider cleanup did not persist')
      }
    }
    // Rebuild the app's cached auth instance after the credential inventory moves.
    await tx`UPDATE settings SET auth_config_version = auth_config_version + 1`
  })
  cacheOpened = true
  // Acceptance fixtures must expose invalidation failure instead of using the
  // product cache helper, which intentionally logs and suppresses Redis errors.
  await getRedis().del(CACHE_KEYS.TENANT_SETTINGS, CACHE_KEYS.PLATFORM_INTEGRATION_TYPES)
  console.log(JSON.stringify({ action, providers: providers.map((provider) => provider.name) }))
} catch {
  // Driver errors can contain SQL parameters. Keep dummy and unrelated values
  // out of job output; the nonzero result still fails the acceptance test.
  console.error('Isolated entry social-provider fixture failed; owned cleanup remains retryable')
  process.exitCode = 1
} finally {
  await sql?.end()
  if (cacheOpened) await getRedis().quit()
}
