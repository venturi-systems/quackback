import {
  VENTURI_COPYRIGHT_HOLDER,
  VENTURI_FOOTER_GROUPS,
  VENTURI_LEGAL_LINKS,
  VENTURI_LOCKUP_SRC,
  VENTURI_SITE_URL,
  sourceCodeUrl,
} from '@/lib/shared/venturi-identity'

interface VenturiSiteFooterProps {
  /** The anonymous entry offers the exact running source without an extra navigation step. */
  showSourceCode?: boolean
}

/** The compact public-site footer, shared by entry, portal and error pages. */
export function VenturiSiteFooter({ showSourceCode = false }: VenturiSiteFooterProps = {}) {
  const year = new Date().getFullYear()
  const commit = typeof __GIT_COMMIT__ === 'string' ? __GIT_COMMIT__ : null
  return (
    <footer className="venturi-footer" data-testid="venturi-site-footer">
      <div className="portal-shell venturi-footer__shell">
        <div className="venturi-footer__brand">
          <a href={VENTURI_SITE_URL} aria-label="Venturi home">
            <img src={VENTURI_LOCKUP_SRC} alt="" className="venturi-brand__lockup" />
          </a>
          <p>The attribution layer for AI.</p>
        </div>
        <nav className="venturi-footer__nav" aria-label="Footer">
          {VENTURI_FOOTER_GROUPS.map((group) => (
            <section key={group.label} aria-labelledby={'footer-' + group.label.toLowerCase()}>
              <h2 id={'footer-' + group.label.toLowerCase()}>{group.label}</h2>
              <ul role="list">
                {group.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      target={'newTab' in link && link.newTab === true ? '_blank' : undefined}
                      rel={
                        'newTab' in link && link.newTab === true ? 'noopener noreferrer' : undefined
                      }
                    >
                      {link.label}
                      {'newTab' in link && link.newTab === true && (
                        <>
                          <span aria-hidden="true"> ↗</span>
                          <span className="sr-only"> (opens in a new tab)</span>
                        </>
                      )}
                    </a>
                  </li>
                ))}
                {showSourceCode && group.label === 'Trust' && (
                  <li>
                    <a href={sourceCodeUrl(commit)}>Source code</a>
                  </li>
                )}
              </ul>
            </section>
          ))}
        </nav>
        <div className="venturi-footer__legal-row">
          <nav className="venturi-footer__legal" aria-label="Legal and sitemap">
            <ul role="list">
              <li className="venturi-footer__copyright">
                &copy; {year} {VENTURI_COPYRIGHT_HOLDER}
              </li>
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
