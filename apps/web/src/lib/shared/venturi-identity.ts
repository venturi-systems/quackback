/**
 * Venturi identity for this fork's public shell (portal, sign-in page, 404
 * and error pages). The fork serves one organization, so the shell carries
 * the approved Venturi signature and the public website's legal row instead
 * of inferring identity from the workspace name.
 *
 * Legal labels and order mirror the public website's footer
 * (venturi-systems/landing-page src/content/site.ts `legalLinks`).
 */
export const VENTURI_SITE_URL = 'https://venturi.systems/'
export const VENTURI_DOCS_URL = 'https://docs.venturi.systems/'
export const VENTURI_PRODUCT_LABEL = 'Feedback'
export const VENTURI_COPYRIGHT_HOLDER = 'Venturi Systems, Inc.'

/** Approved horizontal lockup (fixed black variant for the light register). */
export const VENTURI_LOCKUP_SRC = '/design-system/brand/venturi-lockup-black.svg'

export const VENTURI_LEGAL_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Sitemap', href: 'https://venturi.systems/sitemap/' },
  { label: 'Terms of service', href: 'https://venturi.systems/legal/terms-of-service/' },
  { label: 'Privacy policy', href: 'https://venturi.systems/legal/privacy/' },
  { label: 'Data protection addendum', href: 'https://venturi.systems/legal/dpa/' },
  {
    label: 'Master Services Agreement',
    href: 'https://venturi.systems/legal/master-services-agreement/',
  },
]

export const VENTURI_FOOTER_GROUPS = [
  {
    label: 'Product',
    links: [
      { label: 'Use Cases', href: 'https://venturi.systems/use-cases/' },
      { label: 'How It Works', href: 'https://venturi.systems/how-it-works/' },
      { label: 'Platform', href: 'https://venturi.systems/platform/' },
      { label: 'Documentation', href: VENTURI_DOCS_URL },
      { label: 'Pricing', href: 'https://venturi.systems/pricing/' },
      { label: 'Product demo', href: 'https://venturi.systems/investor/demo/', newTab: true },
      { label: 'Login', href: 'https://app.venturi.systems/' },
    ],
  },
  {
    label: 'Trust',
    links: [
      { label: 'Security', href: 'https://venturi.systems/security/' },
      { label: 'Legal', href: 'https://venturi.systems/legal/' },
      { label: 'Software notices', href: '/software-notices' },
    ],
  },
  {
    label: 'Connect',
    links: [
      { label: 'Contact', href: 'https://venturi.systems/contact/' },
      { label: 'Careers', href: 'https://venturi.systems/careers/' },
      { label: 'Feedback', href: 'https://feedback.venturi.systems/' },
    ],
  },
] as const

const SOURCE_REPOSITORY_URL = 'https://github.com/venturi-systems/quackback'

/**
 * AGPL-3.0 §13 source link: the exact commit this build came from when the
 * build recorded one (SOURCE_COMMIT or git), otherwise the repository.
 */
export function sourceCodeUrl(commit: string | null | undefined): string {
  return commit && /^[0-9a-f]{7,40}$/.test(commit)
    ? `${SOURCE_REPOSITORY_URL}/tree/${commit}`
    : SOURCE_REPOSITORY_URL
}
