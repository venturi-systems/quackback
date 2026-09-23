import { ExclamationCircleIcon } from '@heroicons/react/24/outline'
import { AUTH_BLOCK_MESSAGES, type AuthBlockCode } from '@/lib/server/auth/redirect-errors'

/** The durable message for a sign-in or access redirect code, or null. */
export function authNoticeMessage(code: string | null | undefined): string | null {
  if (!code) return null
  return AUTH_BLOCK_MESSAGES[code as AuthBlockCode] ?? null
}

/**
 * Inline, durable counterpart to the transient sign-in error toast.
 *
 * A redirect such as `?error=not_team_member` used to explain itself only in
 * a toast that disappears after a few seconds. This keeps the explanation on
 * the destination page. It is not a live region: the toast already announces
 * the change, and this copy is part of the page's normal reading order.
 */
export function AuthNotice({ code, className }: { code?: string | null; className?: string }) {
  const message = authNoticeMessage(code)
  if (!message) return null
  return (
    <div
      className={
        'flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm ' +
        (className ?? '')
      }
      data-testid="auth-notice"
    >
      <ExclamationCircleIcon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <p>{message}</p>
    </div>
  )
}
