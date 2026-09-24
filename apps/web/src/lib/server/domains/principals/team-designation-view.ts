/**
 * Read model for Admin > Team designation.
 *
 * - `gaps`: for each stored team member, the team identity rule it fails
 *   (null when the role can act). A member with a gap is shown as inactive:
 *   the server already treats it as a contributor.
 * - `candidates`: contributors whose identity satisfies the rule, so an
 *   administrator can designate them. Only computed for administrators.
 * - `policy`: the configured team domains and sign-in providers, for the
 *   panel's explanation.
 */

import type { UserId } from '@quackback/ids'
import {
  TEAM_IDENTITY_PROVIDER_IDS,
  configuredTeamDomains,
  teamIdentityGap,
  type TeamIdentityGap,
} from './team-identity'

export interface TeamDesignationView {
  gaps: Record<string, TeamIdentityGap | null>
  candidates: Array<{ principalId: string; name: string; email: string }>
  policy: { domains: string[]; providers: string[] }
}

/** Upper bound on candidates returned to the panel. */
const MAX_CANDIDATES = 200

async function providersByUser(userIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (userIds.length === 0) return map
  const { db, account, and, inArray } = await import('@/lib/server/db')
  const links = await db.query.account.findMany({
    where: and(
      inArray(account.userId, userIds as UserId[]),
      inArray(account.providerId, [...TEAM_IDENTITY_PROVIDER_IDS])
    ),
    columns: { userId: true, providerId: true },
  })
  for (const link of links) {
    const list = map.get(link.userId) ?? []
    list.push(link.providerId)
    map.set(link.userId, list)
  }
  return map
}

export async function loadTeamDesignationView(
  members: Array<{
    principalId: string
    userId: string | null
    email: string | null
    emailVerified: boolean
  }>,
  opts: { includeCandidates: boolean }
): Promise<TeamDesignationView> {
  const domains = [...configuredTeamDomains()]
  const linked = await providersByUser(
    members.map((m) => m.userId).filter((id): id is string => Boolean(id))
  )

  const gaps: Record<string, TeamIdentityGap | null> = {}
  for (const m of members) {
    gaps[m.principalId] = teamIdentityGap(
      {
        email: m.email,
        emailVerified: m.emailVerified,
        providerIds: m.userId ? (linked.get(m.userId) ?? []) : [],
      },
      domains
    )
  }

  let candidates: TeamDesignationView['candidates'] = []
  if (opts.includeCandidates) {
    const { db, principal, user, and, eq, or, ilike } = await import('@/lib/server/db')
    const rows = await db
      .select({
        principalId: principal.id,
        userId: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
      })
      .from(principal)
      .innerJoin(user, eq(principal.userId, user.id))
      .where(
        and(
          eq(principal.role, 'user'),
          eq(principal.type, 'user'),
          eq(user.emailVerified, true),
          or(...domains.map((d) => ilike(user.email, `%@${d}`)))
        )
      )
      .limit(MAX_CANDIDATES)
    const candidateLinks = await providersByUser(rows.map((r) => r.userId))
    candidates = rows
      .filter(
        (r) =>
          teamIdentityGap(
            {
              email: r.email,
              emailVerified: r.emailVerified,
              providerIds: candidateLinks.get(r.userId) ?? [],
            },
            domains
          ) === null
      )
      .map((r) => ({ principalId: r.principalId, name: r.name, email: r.email ?? '' }))
  }

  return {
    gaps,
    candidates,
    policy: { domains, providers: ['Google', 'GitHub'] },
  }
}
