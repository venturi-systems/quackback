import type { ReactNode } from 'react'
import { VenturiSiteHeader } from './venturi-site-header'
import { VenturiSiteFooter } from './venturi-site-footer'
import { InShell } from './shell-context'

/**
 * Full public page outside the portal layout: skip link, Venturi header,
 * a reading-start main region, and the shared footer. Used by the sign-in
 * page, the standalone auth pages, and the 404 and error pages.
 */
export function PublicPageFrame({
  children,
  headerActions,
  className,
}: {
  children: ReactNode
  headerActions?: ReactNode
  className?: string
}) {
  return (
    <div className={`public-frame ${className ?? ''}`.trim()}>
      <a href="#public-main" className="public-frame__skip">
        Skip to content
      </a>
      <VenturiSiteHeader actions={headerActions} />
      <main id="public-main" tabIndex={-1} className="public-frame__main">
        <div className="portal-shell public-frame__content">
          <InShell>{children}</InShell>
        </div>
      </main>
      <VenturiSiteFooter />
    </div>
  )
}
