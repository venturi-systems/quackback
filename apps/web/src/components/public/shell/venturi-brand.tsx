import { Link } from '@tanstack/react-router'
import { VENTURI_LOCKUP_SRC } from '@/lib/shared/venturi-identity'

/** The product identity always returns to this portal; company links live in the footer. */
export function VenturiBrand({ spa = false }: { spa?: boolean }) {
  const lockup = <img src={VENTURI_LOCKUP_SRC} alt="" className="venturi-brand__lockup" />
  return (
    <div className="venturi-brand">
      {spa ? (
        <Link to="/" className="venturi-brand__home" aria-label="Venturi feedback home">
          {lockup}
        </Link>
      ) : (
        <a href="/" className="venturi-brand__home" aria-label="Venturi feedback home">
          {lockup}
        </a>
      )}
    </div>
  )
}
