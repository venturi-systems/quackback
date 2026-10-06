/**
 * Admission before a session is minted, rechecked against live approval on
 * protected requests. Authentication proves identity; it does not grant
 * permission to join a private feedback workspace.
 */
import { APIError } from 'better-auth/api'
import type { UserId } from '@quackback/ids'
import { db, user, principal, invitation, session, eq, and, inArray } from '@/lib/server/db'
import { getPortalConfig } from '@/lib/server/domains/settings/settings.service'
import { resolveSessionRole } from '@/lib/server/domains/principals/session-role'
import { matchesApprovedPortalDomain } from '@/lib/server/domains/settings/portal-access'

export const PORTAL_ADMISSION_MESSAGE =
  'This account has not been approved for feedback. Contact the Venturi team for access.'

type PortalAdmission = 'approved' | 'invited' | 'denied'

async function resolvePortalAdmission(userId: string): Promise<PortalAdmission> {
  const config = await getPortalConfig()
  // Preserve the application's public modes. Production's managed policy
  // requires private, so its admission cannot be changed by a public client.
  if (config.access?.visibility === 'public' || config.access?.visibility === 'authenticated')
    return 'approved'
  if (config.access?.visibility !== 'private') return 'denied'

  const person = await db.query.user.findFirst({
    where: eq(user.id, userId as UserId),
    columns: { id: true, email: true, emailVerified: true, isAnonymous: true },
  })
  if (!person || person.isAnonymous || !person.emailVerified || !person.email) return 'denied'

  const record = await db.query.principal.findFirst({
    where: eq(principal.userId, userId as UserId),
    columns: { id: true, role: true, type: true, userId: true },
  })
  if (record?.type !== 'user') return 'denied'
  const role = await resolveSessionRole(record, person)
  if (role === 'admin' || role === 'member') return 'approved'

  if (matchesApprovedPortalDomain(person.email, config.access.allowedDomains ?? []))
    return 'approved'

  // A pending administrator-issued invitation must permit first sign-in so
  // the person can accept it. It still does not grant portal data access:
  // the portal gate requires an accepted invitation. Expired/revoked pending
  // invitations cannot mint sessions; accepted approvals last until revoked.
  const approvals = await db.query.invitation.findMany({
    where: and(
      eq(invitation.email, person.email.trim().toLowerCase()),
      inArray(invitation.kind, ['portal', 'team']),
      inArray(invitation.status, ['accepted', 'pending'])
    ),
    columns: { kind: true, status: true, expiresAt: true },
  })
  // A historical team invitation is not a continuing grant after team
  // membership has been removed. The effective role above owns that grant.
  if (approvals.some((approval) => approval.kind === 'portal' && approval.status === 'accepted')) {
    return 'approved'
  }
  const now = Date.now()
  return approvals.some(
    (approval) => approval.status === 'pending' && approval.expiresAt.getTime() > now
  )
    ? 'invited'
    : 'denied'
}

export async function hasPortalSessionAdmission(userId: string): Promise<boolean> {
  return (await resolvePortalAdmission(userId)) !== 'denied'
}

async function assertPortalAdmission(userId: string, allowPendingInvite: boolean): Promise<void> {
  let admission: PortalAdmission
  try {
    admission = await resolvePortalAdmission(userId)
  } catch {
    // Missing or unavailable policy never becomes an admission grant.
    throw new APIError('FORBIDDEN', { message: PORTAL_ADMISSION_MESSAGE })
  }
  if (admission === 'denied') {
    // Revoke every old session after approval is removed. If cleanup is
    // unavailable, the request still fails closed at the admission boundary.
    try {
      await db.delete(session).where(eq(session.userId, userId as UserId))
    } catch {
      console.error('[Portal admission] Session revocation failed')
    }
    throw new APIError('FORBIDDEN', { message: PORTAL_ADMISSION_MESSAGE })
  }
  if (admission === 'invited' && !allowPendingInvite) {
    // Keep the session so its owner can accept the invitation, while denying
    // directory, storage and widget access until that acceptance is recorded.
    throw new APIError('FORBIDDEN', { message: 'Accept your invitation to access feedback.' })
  }
}

export async function assertPortalSessionAdmission(userId: string): Promise<void> {
  await assertPortalAdmission(userId, true)
}

export async function assertPortalContentAdmission(userId: string): Promise<void> {
  await assertPortalAdmission(userId, false)
}
