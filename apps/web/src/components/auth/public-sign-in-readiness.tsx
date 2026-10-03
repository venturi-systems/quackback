import { useSyncExternalStore, type ReactNode } from 'react'
import { FormattedMessage } from 'react-intl'
import { VENTURI_SITE_URL } from '@/lib/shared/venturi-identity'

const subscribe = () => () => {}
const clientReady = () => true
const serverReady = () => false

/** Keep server-rendered controls inert until their handlers are attached.
 * Native help remains available without scripts and after a failed sign-in.
 * Its compact summary keeps the same geometry through hydration.
 */
export function PublicSignInReadiness({ children }: { children: ReactNode }) {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady)
  return (
    <div className="space-y-4" data-public-sign-in-ready={ready}>
      <fieldset disabled={!ready} className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
      {/* A native toggle before hydration may add open. Preserve that browser-owned
          state; all other attributes remain deterministic. */}
      <details className="text-base" data-public-sign-in-help suppressHydrationWarning>
        <summary className="min-h-11 cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          {/* Both labels size one grid cell, so translations and text enlargement
              cannot move the form when readiness changes. Only one is exposed. */}
          <span className="inline-grid align-middle">
            <span
              aria-hidden={ready}
              className={`col-start-1 row-start-1 ${ready ? 'invisible' : ''}`}
            >
              <FormattedMessage
                id="portal.auth.scriptsRequired"
                defaultMessage="Sign-in needs JavaScript"
              />
            </span>
            <span
              aria-hidden={!ready}
              className={`col-start-1 row-start-1 ${ready ? '' : 'invisible'}`}
            >
              <FormattedMessage id="portal.auth.signInHelp" defaultMessage="Sign-in help" />
            </span>
          </span>
        </summary>
        <div className="space-y-2">
          <p>
            <FormattedMessage
              id="portal.auth.signInRecovery"
              defaultMessage="If sign-in does not open, enable JavaScript and reload this page."
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
      </details>
    </div>
  )
}
