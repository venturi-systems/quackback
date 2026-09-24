import { createFileRoute } from '@tanstack/react-router'
import { withApiKeyAuth } from '@/lib/server/domains/api/auth'
import { successResponse, handleDomainError } from '@/lib/server/domains/api/responses'
import { ForbiddenError, NotFoundError } from '@/lib/shared/errors'
import { parseTypeId } from '@/lib/server/domains/api/validation'
import type { PrincipalId } from '@quackback/ids'
import { isTeamMember } from '@/lib/shared/roles'

/** Why the REST API never writes a team role. */
const ROLE_WRITE_REFUSAL =
  'Team roles are designated by a signed-in administrator in Admin > Team. API keys cannot give, change or remove a team role.'

/** Fetch a team member with user details, or throw NotFoundError. */
async function fetchTeamMemberWithUser(principalId: PrincipalId) {
  const { getMemberById } = await import('@/lib/server/domains/principals/principal.service')
  const { db, eq, user } = await import('@/lib/server/db')

  const member = await getMemberById(principalId)
  if (!member) throw new NotFoundError('MEMBER_NOT_FOUND', 'Member not found')
  if (!isTeamMember(member.role)) {
    throw new NotFoundError('MEMBER_NOT_FOUND', 'Team member not found')
  }
  if (!member.userId) throw new NotFoundError('USER_NOT_FOUND', 'User not found')

  const userDetails = await db.query.user.findFirst({
    where: eq(user.id, member.userId),
  })
  if (!userDetails) throw new NotFoundError('USER_NOT_FOUND', 'User not found')

  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    name: userDetails.name,
    email: userDetails.email,
    image: userDetails.image,
    createdAt: member.createdAt.toISOString(),
  }
}

export const Route = createFileRoute('/api/v1/principals/$principalId')({
  server: {
    handlers: {
      /**
       * GET /api/v1/principals/:principalId
       * Get a single team member by ID
       */
      GET: async ({ request, params }) => {
        try {
          await withApiKeyAuth(request, { role: 'team' })

          const principalId = parseTypeId<PrincipalId>(
            params.principalId,
            'principal',
            'principal ID'
          )

          const result = await fetchTeamMemberWithUser(principalId)

          return successResponse(result)
        } catch (error) {
          return handleDomainError(error)
        }
      },

      /**
       * PATCH /api/v1/principals/:principalId
       * Refused: team roles are designated by a signed-in administrator in
       * Admin > Team, where the team identity rule is checked. An API key is a
       * service principal, not a designated person, so it cannot give, change
       * or remove a team role (owner decisions 6 and 7, landing-page#2309).
       */
      PATCH: async ({ request }) => {
        try {
          await withApiKeyAuth(request, { role: 'admin' })
          throw new ForbiddenError('ROLE_DESIGNATION_REQUIRES_ADMIN_SESSION', ROLE_WRITE_REFUSAL)
        } catch (error) {
          return handleDomainError(error)
        }
      },

      /**
       * DELETE /api/v1/principals/:principalId
       * Refused for the same reason as PATCH.
       */
      DELETE: async ({ request }) => {
        try {
          await withApiKeyAuth(request, { role: 'admin' })
          throw new ForbiddenError('ROLE_DESIGNATION_REQUIRES_ADMIN_SESSION', ROLE_WRITE_REFUSAL)
        } catch (error) {
          return handleDomainError(error)
        }
      },
    },
  },
})
