import { createFileRoute, redirect } from '@tanstack/react-router'
import { safeSigninRedirect } from '@/lib/shared/auth-prompt'
import { signinRedirectSearch } from '@/lib/shared/auth-route-search'

export const Route = createFileRoute('/auth/signup')({
  // Tolerant: `?callbackUrl=123` or `?error=123` reads as text, never a 500.
  validateSearch: signinRedirectSearch,
  beforeLoad: ({ search }) => {
    throw redirect(safeSigninRedirect(search, '/', { mode: 'signup' }))
  },
})
