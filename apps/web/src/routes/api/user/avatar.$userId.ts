import { createFileRoute } from '@tanstack/react-router'
import { isValidTypeId, type UserId } from '@quackback/ids'
import { auth } from '@/lib/server/auth'
import { db, eq, principal, user } from '@/lib/server/db'
import { isTeamMember } from '@/lib/shared/roles'
import { resolveSessionRole } from '@/lib/server/domains/principals/session-role'
import { getPublicUrlOrNull } from '@/lib/server/storage/s3'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'user-avatar' })

const notFound = () => Response.json({ error: 'User not found' }, { status: 404 })

/**
 * An avatar looked up by user id is identity data, so the same rule applies
 * as for `fetchUserAvatar` (functions/portal.ts): the account itself, or a
 * team member under the team identity rule, may read it. Anyone else, signed
 * in or not, gets the not-found answer an unknown id gets, so the route is
 * neither an open lookup nor an existence oracle for arbitrary ids
 * (remediation ledger DEF-10, landing-page#2309).
 */
async function callerMayReadAvatar(request: Request, userId: UserId): Promise<boolean> {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null)
  if (!session?.user) return false
  if (session.user.id === userId) return true
  const principalRecord = await db.query.principal.findFirst({
    where: eq(principal.userId, session.user.id as UserId),
    columns: { id: true, userId: true, role: true, type: true },
  })
  if (!principalRecord) return false
  return isTeamMember(await resolveSessionRole(principalRecord, session.user, request.headers))
}

/**
 * GET /api/user/avatar/[userId]
 * Redirect to user avatar image URL (S3 or OAuth provider).
 */
export async function handleUserAvatar({
  request,
  params,
}: {
  request: Request
  params: { userId: string }
}): Promise<Response> {
  try {
    const userIdParam = params.userId

    // Validate TypeID format
    if (!isValidTypeId(userIdParam, 'user')) {
      return Response.json({ error: 'Invalid user ID format' }, { status: 400 })
    }
    const userId = userIdParam as UserId

    if (!(await callerMayReadAvatar(request, userId))) return notFound()

    const userRecord = await db.query.user.findFirst({
      where: eq(user.id, userId),
      columns: {
        imageKey: true,
        image: true,
      },
    })

    if (!userRecord) return notFound()

    // If user has an S3 avatar, redirect to it (this takes priority)
    if (userRecord.imageKey) {
      const s3Url = getPublicUrlOrNull(userRecord.imageKey)
      if (s3Url) {
        return Response.redirect(s3Url)
      }
    }

    // If user has an external URL-based image (from OAuth), redirect to it
    if (userRecord.image && !userRecord.image.startsWith('/api/user/avatar/')) {
      return Response.redirect(userRecord.image)
    }

    // No avatar available
    return Response.json({ error: 'No avatar found' }, { status: 404 })
  } catch (error) {
    log.error({ err: error }, 'avatar fetch failed')
    return Response.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export const Route = createFileRoute('/api/user/avatar/$userId')({
  server: {
    handlers: {
      GET: handleUserAvatar,
    },
  },
})
