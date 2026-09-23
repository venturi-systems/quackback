'use client'

import { useEffect } from 'react'
import { createFileRoute, useNavigate, useRouteContext } from '@tanstack/react-router'
import { SettingsNav, firstSettingsPath } from '@/components/admin/settings/settings-nav'
import { AdminOnlyNotice } from '@/components/admin/settings/admin-only-notice'
import { PageHeader } from '@/components/shared/page-header'
import { Cog6ToothIcon } from '@heroicons/react/24/solid'
import { useMediaQuery } from '@/lib/client/hooks/use-media-query'

export const Route = createFileRoute('/admin/settings/')({
  validateSearch: (search: Record<string, unknown>): { error?: 'not_admin' } => ({
    error: search.error === 'not_admin' ? 'not_admin' : undefined,
  }),
  component: SettingsIndexPage,
})

function SettingsIndexPage() {
  const navigate = useNavigate()
  const { error } = Route.useSearch()
  const { userRole } = useRouteContext({ from: '__root__' })
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const denied = error === 'not_admin' && userRole !== 'admin'

  // On desktop the sidebar handles navigation, so open the first page this
  // role can use. A member who was sent here from an administrator-only page
  // stays on the durable notice instead.
  useEffect(() => {
    if (isDesktop && !denied) {
      navigate({ to: firstSettingsPath(userRole), replace: true })
    }
  }, [isDesktop, denied, userRole, navigate])

  return (
    <div className="space-y-6">
      {denied && <AdminOnlyNotice />}
      <div className="lg:hidden">
        <PageHeader icon={Cog6ToothIcon} title="Settings" className="mb-6" />
        <SettingsNav />
      </div>
    </div>
  )
}
