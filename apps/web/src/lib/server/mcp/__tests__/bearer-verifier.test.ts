// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { verifyBearerToken } from 'better-auth/oauth2'

const ISSUER = 'https://qb.example/api/auth'
const AUDIENCE = 'https://qb.example/api/mcp'
afterEach(() => vi.unstubAllGlobals())

describe('published MCP bearer verifier security contract', () => {
  it('validates signature, issuer and audience, and refuses sender-bound tokens as bearer', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256')
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'mcp-bearer-regression',
      alg: 'ES256',
      use: 'sig',
    }
    const fetch = vi.fn(async () => Response.json({ keys: [jwk] }))
    vi.stubGlobal('fetch', fetch)
    const options = {
      jwksUrl: `${ISSUER}/jwks?regression=bearer`,
      verifyOptions: { issuer: ISSUER, audience: AUDIENCE },
    }
    const token = (claims: Record<string, unknown> = {}) =>
      new SignJWT({ scope: 'read:feedback', ...claims })
        .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('user_ada')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
    await expect(verifyBearerToken(await token(), options)).resolves.toMatchObject({
      sub: 'user_ada',
      aud: AUDIENCE,
      iss: ISSUER,
    })
    await expect(
      verifyBearerToken(await token({ cnf: { jkt: 'sender-key-thumbprint' } }), options)
    ).rejects.toThrow(/DPoP-bound/)
    await expect(
      verifyBearerToken(await token(), {
        ...options,
        verifyOptions: { ...options.verifyOptions, audience: 'https://other.example/api' },
      })
    ).rejects.toThrow()
    await expect(
      verifyBearerToken(await token(), {
        ...options,
        verifyOptions: { ...options.verifyOptions, issuer: 'https://other.example/auth' },
      })
    ).rejects.toThrow()
    const [header, payload, signature] = (await token()).split('.')
    const tampered = `${header}.${payload}.${signature.slice(0, -8)}AAAAAAAA`
    await expect(verifyBearerToken(tampered, options)).rejects.toThrow()
    expect(fetch).toHaveBeenCalled()
  })
})
