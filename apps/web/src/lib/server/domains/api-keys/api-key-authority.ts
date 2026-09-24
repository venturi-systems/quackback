/**
 * The role an API key may exercise right now.
 *
 * A key's service principal carries the role its creator held when the key
 * was made. That snapshot is not enough: the team identity rule decides who
 * may exercise a team role today, and it must bind keys too, or a key minted
 * by an account that no longer qualifies (for example a password-only
 * bootstrap administrator) would keep full authority forever.
 *
 * So a key's role is the lower of
 *   - its service principal's stored role, and
 *   - its creator's current role under the team identity rule.
 * A key whose creator is gone, or never had a team role, acts as a
 * contributor, which every REST and MCP team check refuses.
 */

import type { PrincipalId } from '@quackback/ids'
import type { Role } from '@/lib/shared/roles'
import { resolveTeamRole } from '@/lib/server/domains/principals/team-identity'

const RANK: Record<Role, number> = { user: 0, member: 1, admin: 2 }

function asRole(role: string | null | undefined): Role {
  return role === 'admin' || role === 'member' ? role : 'user'
}

/** The lower of two roles. */
export function lowerRole(a: Role, b: Role): Role {
  return RANK[a] <= RANK[b] ? a : b
}

export async function resolveApiKeyRole(
  apiKey: { createdById: PrincipalId | null },
  keyPrincipalRole: string | null | undefined
): Promise<Role> {
  const keyRole = asRole(keyPrincipalRole)
  if (keyRole === 'user' || !apiKey.createdById) return 'user'

  const { db, principal, eq } = await import('@/lib/server/db')
  const creator = await db.query.principal.findFirst({
    where: eq(principal.id, apiKey.createdById),
    columns: { id: true, role: true, type: true, userId: true },
  })
  if (!creator) return 'user'

  const creatorRole = await resolveTeamRole(creator)
  return lowerRole(keyRole, creatorRole)
}
