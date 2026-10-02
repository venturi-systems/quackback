import { useSyncExternalStore, type ReactNode } from 'react'
import { FormattedMessage } from 'react-intl'
import { VENTURI_SITE_URL } from '@/lib/shared/venturi-identity'

const subscribe = () => () => {}
const clientReady = () => true
const serverReady = () => false

/** Keep server-rendered controls inert until their handlers are attached.
 * The native recovery links also work when JavaScript is disabled or fails
 * to load; no inline script or alternate OAuth endpoint is needed.
 */
export function PublicSignInReadiness({ children }: { children: ReactNode }) {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady)
  return (
    <div className="space-y-4" data-public-sign-in-ready={ready}>
      {!ready && (
        <div className="space-y-2 text-base" role="status">
          <p>
            <FormattedMessage
              id="portal.auth.loadingRecovery"
              defaultMessage="Sign-in is loading. If it does not appear, enable JavaScript and reload this page."
            />
          </p>
          <p className="flex flex-wrap gap-x-4">
            <a href="" className="inline-flex min-h-11 items-center underline underline-offset-4">
              <FormattedMessage id="portal.auth.reloadPage" defaultMessage="Reload this page" />
            </a>
            <a
              href={VENTURI_SITE_URL}
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              <FormattedMessage id="portal.auth.venturiHome" defaultMessage="Venturi home" />
            </a>
          </p>
        </div>
      )}
      <fieldset disabled={!ready} className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
    </div>
  )
}
