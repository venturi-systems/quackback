import { useMemo } from 'react'
import { useRouteContext } from '@tanstack/react-router'
import { PublicPageFrame } from '@/components/public/shell/public-page-frame'
import { generateThemeCSS, getGoogleFontsUrl } from '@/lib/shared/theme'
import type { BrandingConfig } from '@/lib/server/domains/settings/settings.types'

interface PortalAuthShellProps {
  heading: React.ReactNode
  subheading?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}

/**
 * Shared layout for public-portal auth pages (`/auth/reset-password`,
 * `/auth/recovery`).
 *
 * Renders the public page frame (Venturi header and footer, reading-start
 * main region) plus the workspace theme CSS variables, brand fonts and the
 * custom CSS override slot, so the visual handoff to a signed-in portal page
 * is seamless. Auth routes sit outside `_portal` (they do not render the
 * portal navigation). The heading and form share the page's left rail; the
 * form keeps a form-sized column.
 */
export function PortalAuthShell({ heading, subheading, children, footer }: PortalAuthShellProps) {
  const ctx = useRouteContext({ from: '__root__' }) as {
    settings?: { brandingConfig?: BrandingConfig; customCss?: string }
  }
  const brandingConfig = ctx.settings?.brandingConfig
  const customCss = ctx.settings?.customCss ?? ''

  const themeStyles = useMemo(() => {
    if (!brandingConfig) return ''
    const hasThemeConfig = brandingConfig.light || brandingConfig.dark
    return hasThemeConfig ? generateThemeCSS(brandingConfig) : ''
  }, [brandingConfig])
  const googleFontsUrl = useMemo(
    () => (brandingConfig ? getGoogleFontsUrl(brandingConfig) : null),
    [brandingConfig]
  )

  return (
    <>
      {googleFontsUrl && <link rel="stylesheet" href={googleFontsUrl} />}
      {themeStyles && <style dangerouslySetInnerHTML={{ __html: themeStyles }} />}
      {customCss && <style dangerouslySetInnerHTML={{ __html: customCss }} />}
      <PublicPageFrame className="public-auth">
        <div className="public-auth__intro">
          <h1 className="public-status__title">{heading}</h1>
          {subheading && <p className="public-status__lead">{subheading}</p>}
        </div>
        <div className="public-auth__form">
          {children}
          {footer}
        </div>
      </PublicPageFrame>
    </>
  )
}
