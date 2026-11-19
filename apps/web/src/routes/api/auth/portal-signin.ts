import { createFileRoute } from '@tanstack/react-router'
import { isAPIError } from 'better-auth/api'
import { requestEmailSignin } from '@/lib/server/auth/email-signin'
import { AUTH_BLOCK_MESSAGES } from '@/lib/server/auth/redirect-errors'
import { logger } from '@/lib/server/logger'

const log = logger.child({ component: 'portal-signin' })

interface PortalSigninBody {
  email?: unknown
  callbackURL?: unknown
}

export const Route = createFileRoute('/api/auth/portal-signin')({
  server: {
    handlers: {
      /**
       * POST /api/auth/portal-signin
       * Triggers a passwordless sign-in email containing both a magic
       * link and a 6-digit OTP. The frontend then shows the OTP input
       * as primary; users can also click the link in the email.
       */
      POST: async ({ request }) => {
        let body: PortalSigninBody
        try {
          body = (await request.json()) as PortalSigninBody
        } catch {
          return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        if (typeof body.email !== 'string' || !body.email.includes('@')) {
          return Response.json({ error: 'Valid email required' }, { status: 400 })
        }
        const callbackURL = typeof body.callbackURL === 'string' ? body.callbackURL : '/'

        try {
          await requestEmailSignin({ email: body.email, callbackURL })
          return Response.json({ ok: true })
        } catch (err) {
          // The Better Auth pre-check redirects browsers, but this form expects JSON.
          if (isAPIError(err) && err.status === 'FOUND') {
            const location = new Headers(err.headers).get('location')
            const target = location ? URL.parse(location, request.url) : null
            if (
              target?.origin === new URL(request.url).origin &&
              target.pathname === '/' &&
              target.searchParams.get('auth') === 'signin' &&
              target.searchParams.get('error') === 'magic_link_method_not_allowed'
            ) {
              return Response.json(
                { error: AUTH_BLOCK_MESSAGES.magic_link_method_not_allowed },
                { status: 403 }
              )
            }
          }
          log.error({ err }, 'portal signin failed')
          return Response.json(
            { error: err instanceof Error ? err.message : 'Failed to send sign-in email' },
            { status: 500 }
          )
        }
      },
    },
  },
})
