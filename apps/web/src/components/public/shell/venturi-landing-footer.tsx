import { sourceCodeUrl } from '@/lib/shared/venturi-identity'

/** Compact utilities for the authentication entry only; signed-in chrome is unchanged. */
export function VenturiLandingFooter() {
  const commit = typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : null
  return (
    <footer className="venturi-landing-footer" data-testid="venturi-landing-footer">
      <nav aria-label="Source and sitemap">
        <a href={sourceCodeUrl(commit)}>Source code</a>
        <a href="https://venturi.systems/sitemap/">Sitemap</a>
      </nav>
    </footer>
  )
}
