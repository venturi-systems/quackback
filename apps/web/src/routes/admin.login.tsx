import { createFileRoute, redirect } from '@tanstack/react-router'
import { safeSigninRedirect } from '@/lib/shared/auth-prompt'
import { signinRedirectSearch } from '@/lib/shared/auth-route-search'

export function adminLoginRedirectTarget(d: { callbackUrl?: string; error?: string }) {
  return safeSigninRedirect(d, '/admin')
}

export const Route = createFileRoute('/admin/login')({
  // Tolerant: `?error=123` or `?callbackUrl=123` reads as text, never a 500.
  validateSearch: signinRedirectSearch,
  beforeLoad: ({ search }) => {
    throw redirect(adminLoginRedirectTarget(search))
  },
})
