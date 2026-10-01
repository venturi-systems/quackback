import {
  VENTURI_COPYRIGHT_HOLDER,
  VENTURI_DOCS_URL,
  VENTURI_LEGAL_LINKS,
  VENTURI_SITE_URL,
  sourceCodeUrl,
} from '@/lib/shared/venturi-identity'

/** Build-time commit, when the bundler defines one (tests do not). */
function buildCommit(): string | null {
  return typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : null
}

/**
 * Public footer shared by the portal, the sign-in page, and the 404 and error
 * pages. Related sites and the AGPL source link, then the full-width legal
 * row in the public website's order and labels.
 */
type FooterSourceLink = { label: string; href: string }

export function VenturiSiteFooter({
  sourceLink,
}: {
  sourceLink?: FooterSourceLink
} = {}) {
  const year = new Date().getFullYear()
  const relatedSourceLink = sourceLink ?? {
    label: 'Source code (AGPL-3.0)',
    href: sourceCodeUrl(buildCommit()),
  }
  return (
    <footer className="venturi-footer" data-testid="venturi-site-footer">
      <div className="portal-shell venturi-footer__shell">
        <nav className="venturi-footer__related" aria-label="Related Venturi sites">
          <a href={VENTURI_SITE_URL}>Venturi</a>
          <a href={VENTURI_DOCS_URL}>Documentation</a>
          <a href={relatedSourceLink.href}>{relatedSourceLink.label}</a>
        </nav>
        <div className="venturi-footer__legal-row">
          <p className="venturi-footer__copyright">
            &copy; {year} {VENTURI_COPYRIGHT_HOLDER}
          </p>
          <nav className="venturi-footer__legal" aria-label="Legal and sitemap">
            <ul>
              {VENTURI_LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href}>{link.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  )
}
