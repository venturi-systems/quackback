import type { ReactNode } from 'react'
import { VenturiBrand } from './venturi-brand'

/**
 * Minimal public header for pages outside the portal layout (sign-in page,
 * 404 and error pages): the brand cluster plus optional actions.
 */
export function VenturiSiteHeader({ actions }: { actions?: ReactNode }) {
  return (
    <header className="portal-header venturi-site-header">
      <div className="portal-shell venturi-site-header__row">
        <VenturiBrand />
        {actions ? <div className="venturi-site-header__actions">{actions}</div> : null}
      </div>
    </header>
  )
}
