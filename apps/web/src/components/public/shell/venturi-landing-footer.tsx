import {
  VENTURI_COPYRIGHT_HOLDER,
  VENTURI_LEGAL_LINKS,
  VENTURI_LOCKUP_SRC,
  VENTURI_SITE_URL,
} from '@/lib/shared/venturi-identity'

// Mirrors landing-page/src/content/site.ts and Footer.astro. This footer is
// opt-in for the unauthenticated entry; the authenticated footer stays intact.
const groups = [
  {
    label: 'Product',
    links: [
      ['Use Cases', 'https://venturi.systems/use-cases/'],
      ['How It Works', 'https://venturi.systems/how-it-works/'],
      ['Platform', 'https://venturi.systems/platform/'],
      ['Documentation', 'https://docs.venturi.systems/'],
    ],
  },
  {
    label: 'Trust',
    links: [
      ['Security', 'https://venturi.systems/security/'],
      ['Deployment', 'https://venturi.systems/platform/'],
      ['Privacy', 'https://venturi.systems/legal/privacy/'],
    ],
  },
  {
    label: 'Connect',
    links: [
      ['Contact', 'https://venturi.systems/contact/'],
      ['Careers', 'https://venturi.systems/careers/'],
      ['Feedback', 'https://feedback.venturi.systems/'],
      ['Login', 'https://app.venturi.systems/'],
    ],
  },
] as const

export function VenturiLandingFooter() {
  return (
    <footer className="venturi-landing-footer" data-testid="venturi-landing-footer">
      <div className="portal-shell venturi-landing-footer__shell">
        <div className="venturi-landing-footer__brand">
          <a href={VENTURI_SITE_URL} className="venturi-brand__home" aria-label="Venturi home">
            <img src={VENTURI_LOCKUP_SRC} alt="" className="venturi-brand__lockup" />
          </a>
          <p>The attribution layer for AI.</p>
        </div>
        <nav className="venturi-landing-footer__nav" aria-label="Footer">
          {groups.map((group) => (
            <section key={group.label} aria-labelledby={`footer-${group.label.toLowerCase()}`}>
              <h2 id={`footer-${group.label.toLowerCase()}`}>{group.label}</h2>
              <ul>
                {group.links.map(([label, href]) => (
                  <li key={label}>
                    <a href={href}>{label}</a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <div className="venturi-landing-footer__row">
          <p className="venturi-landing-footer__copyright">
            &copy; {new Date().getFullYear()} {VENTURI_COPYRIGHT_HOLDER}
          </p>
          <a className="venturi-landing-footer__top" href="#feedback-entry-top">
            Back to top ↑
          </a>
          <nav className="venturi-landing-footer__legal" aria-label="Legal and sitemap">
            <ul>
              {VENTURI_LEGAL_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href}>{link.label}</a>
                </li>
              ))}
            </ul>
          </nav>
          <a className="venturi-landing-footer__notices" href="/software-notices">
            Software notices
          </a>
        </div>
      </div>
    </footer>
  )
}
