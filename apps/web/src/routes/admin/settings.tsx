'use client'

import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { Cog6ToothIcon } from '@heroicons/react/24/solid'
import { SettingsNav, isMemberSettingsPath } from '@/components/admin/settings/settings-nav'
import { PageHeader } from '@/components/shared/page-header'
import { ScrollArea } from '@/components/ui/scroll-area'
import { settingsQueries } from '@/lib/client/queries/settings'

/** Effective role resolved by the /admin guard (effectiveRole-capped). */
function principalRole(context: unknown): string | undefined {
  return (context as { principal?: { role?: string } }).principal?.role
}

export const Route = createFileRoute('/admin/settings')({
  // Settings are administrator-only except the pages members may change
  // (statuses, tags). A member who opens any other settings URL lands on the
  // settings page's durable "Administrators only" state instead of an error
  // boundary. The server still refuses every admin-only call on its own.
  beforeLoad: ({ context, location }) => {
    if (principalRole(context) !== 'admin' && !isMemberSettingsPath(location.pathname)) {
      throw redirect({ to: '/admin/settings', search: { error: 'not_admin' } })
    }
  },
  // Prefetch the queries consumed by the SSO callout on /authentication.
  // Both feeds drive the callout's adaptive copy; cheap — settings-cache
  // hits that are reused downstream by the /sso route loader too. Both are
  // admin-only, so members skip them (they never see that page).
  loader: async ({ context }) => {
    if (principalRole(context) !== 'admin') return {}
    await Promise.all([
      context.queryClient.ensureQueryData(settingsQueries.authConfig()),
      context.queryClient.ensureQueryData(settingsQueries.verifiedDomains()),
    ])
    return {}
  },
  component: SettingsLayout,
})

function SettingsLayout() {
  return (
    <div className="flex h-full bg-background">
      <aside className="hidden lg:flex w-64 xl:w-72 shrink-0 flex-col border-r border-border/50 bg-card/30 overflow-hidden">
        <div className="shrink-0 px-4 py-3.5">
          <PageHeader icon={Cog6ToothIcon} title="Settings" />
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 pb-5">
            <SettingsNav />
          </div>
        </ScrollArea>
      </aside>

      <main className="flex-1 min-w-0 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="p-6">
            <Outlet />
          </div>
        </ScrollArea>
      </main>
    </div>
  )
}
