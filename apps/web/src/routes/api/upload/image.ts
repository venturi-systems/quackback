import { createFileRoute } from '@tanstack/react-router'
import type { UserId } from '@quackback/ids'
import { auth } from '@/lib/server/auth'
import { db, eq, principal } from '@/lib/server/db'
import { effectiveRole, isTeamMember } from '@/lib/shared/roles'
import { isS3Configured, uploadImageFromFormData } from '@/lib/server/storage/s3'

const ALLOWED_PREFIXES = new Set([
  'uploads',
  'changelog-images',
  'changelog',
  'post-images',
  'help-center',
  'chat-images',
])

export async function handleAdminUpload({ request }: { request: Request }): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const principalRecord = await db.query.principal.findFirst({
    where: eq(principal.userId, session.user.id as UserId),
    columns: { role: true, type: true },
  })
  // A team role only counts on a human principal (see effectiveRole): an
  // anonymous principal carrying admin/member is a portal user here too.
  if (
    !principalRecord ||
    !isTeamMember(effectiveRole(principalRecord.role, principalRecord.type))
  ) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!isS3Configured()) {
    return Response.json({ error: 'Storage not configured' }, { status: 503 })
  }
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const rawPrefix = formData.get('prefix')
  const prefix =
    typeof rawPrefix === 'string' && ALLOWED_PREFIXES.has(rawPrefix) ? rawPrefix : 'uploads'
  return uploadImageFromFormData(formData, prefix)
}

export const Route = createFileRoute('/api/upload/image')({
  server: {
    handlers: {
      POST: handleAdminUpload,
    },
  },
})
