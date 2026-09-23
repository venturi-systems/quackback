import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { SettingsNav } from '@/components/settings/settings-nav'

/**
 * Settings layout for authenticated users.
 * Provides sidebar navigation for profile and preferences.
 * Requires authentication - redirects to login if not authenticated.
 */
export const Route = createFileRoute('/_portal/settings')({
  beforeLoad: ({ context }) => {
    // Require authentication for settings pages
    if (!context.session?.user) {
      throw redirect({ to: '/' })
    }
  },
  component: SettingsLayout,
})

function SettingsLayout() {
  return (
    <div className="portal-page flex flex-col md:flex-row gap-4 md:gap-8 py-6 md:py-8 flex-1 animate-in fade-in duration-200">
      <SettingsNav />
      {/* The portal layout already provides the page's single main landmark. */}
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
