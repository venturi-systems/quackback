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
