import { Link } from '@tanstack/react-router'
import {
  VENTURI_LOCKUP_SRC,
  VENTURI_PRODUCT_LABEL,
  VENTURI_SITE_URL,
} from '@/lib/shared/venturi-identity'

/**
 * Brand cluster for every public header: the approved lockup links to the
 * Venturi website ("Venturi home"), and the product label links to the
 * portal home. Two destinations, two named links.
 *
 * `spa` uses the router for the portal-home link. Pages that can render
 * without a router (error and 404 pages) keep a plain link.
 */
export function VenturiBrand({ spa = false }: { spa?: boolean }) {
  return (
    <div className="venturi-brand">
      <a href={VENTURI_SITE_URL} className="venturi-brand__home" aria-label="Venturi home">
        <img src={VENTURI_LOCKUP_SRC} alt="" className="venturi-brand__lockup" />
      </a>
      {spa ? (
        <Link to="/" className="venturi-brand__product">
          {VENTURI_PRODUCT_LABEL}
        </Link>
      ) : (
        <a href="/" className="venturi-brand__product">
          {VENTURI_PRODUCT_LABEL}
        </a>
      )}
    </div>
  )
}
