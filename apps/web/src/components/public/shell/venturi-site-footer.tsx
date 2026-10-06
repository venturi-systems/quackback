import {
  VENTURI_COPYRIGHT_HOLDER,
  VENTURI_FOOTER_GROUPS,
  VENTURI_LEGAL_LINKS,
  VENTURI_LOCKUP_SRC,
  VENTURI_SITE_URL,
} from '@/lib/shared/venturi-identity'

/** The compact public-site footer, shared by entry, portal and error pages. */
export function VenturiSiteFooter() {
  const year = new Date().getFullYear()
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
              <ul>
                {group.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      target={'newTab' in link && link.newTab ? '_blank' : undefined}
                      rel={'newTab' in link && link.newTab ? 'noopener noreferrer' : undefined}
                    >
                      {link.label}
                      {'newTab' in link && link.newTab && (
                        <>
                          <span aria-hidden="true"> ↗</span>
                          <span className="sr-only"> (opens in a new tab)</span>
                        </>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <div className="venturi-footer__legal-row">
          <nav className="venturi-footer__legal" aria-label="Legal and sitemap">
            <ul>
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
