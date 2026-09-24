/**
 * Claims this fork adds to an OAuth access token minted by the MCP
 * authorization server (`oauthProvider` in auth/index.ts).
 *
 * `role` is the role the principal may exercise when the token is minted,
 * under the team identity rule (resolveTeamRole in team-identity.ts), never
 * the raw stored role: a client that reads the claim must not see `admin` on
 * an account the rule treats as a contributor (landing-page#2309). The MCP
 * handler does not trust the claim for authority either; it re-resolves the
 * role from the database on every call (mcp/handler.ts).
 */
import type { UserId } from '@quackback/ids'

export async function accessTokenClaims(
  user: { id?: string | null; name?: string | null; email?: string | null } | null | undefined
): Promise<Record<string, unknown>> {
  if (!user?.id) return {}
  const { db, principal, eq } = await import('@/lib/server/db')
  const p = await db.query.principal.findFirst({
    where: eq(principal.userId, user.id as UserId),
    columns: { id: true, role: true, type: true, userId: true },
  })
  const { resolveTeamRole } = await import('@/lib/server/domains/principals/team-identity')
  return {
    principalId: p?.id,
    role: p ? await resolveTeamRole(p) : 'user',
    name: user.name,
    email: user.email,
  }
}
