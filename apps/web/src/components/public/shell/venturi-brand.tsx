import { Link } from '@tanstack/react-router'
import {
  VENTURI_LOCKUP_SRC,
  VENTURI_PRODUCT_LABEL,
  VENTURI_SITE_URL,
} from '@/lib/shared/venturi-identity'

/**
 * The signed-in portal uses one lockup linked to portal home; its navigation
 * supplies the Feedback label. Public entry, error and 404 pages retain their
 * existing company and product links without requiring a router.
 */
export function VenturiBrand({ spa = false }: { spa?: boolean }) {
  if (spa) {
    return (
      <div className="venturi-brand">
        <Link to="/" className="venturi-brand__home" aria-label="Venturi Feedback home">
          <img src={VENTURI_LOCKUP_SRC} alt="" className="venturi-brand__lockup" />
        </Link>
      </div>
    )
  }

  return (
    <div className="venturi-brand">
      <a href={VENTURI_SITE_URL} className="venturi-brand__home" aria-label="Venturi home">
        <img src={VENTURI_LOCKUP_SRC} alt="" className="venturi-brand__lockup" />
      </a>
      <a href="/" className="venturi-brand__product">
        {VENTURI_PRODUCT_LABEL}
      </a>
    </div>
  )
}
