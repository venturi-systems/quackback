import { createFileRoute, Navigate, Outlet } from '@tanstack/react-router'
import { z } from 'zod'
import type { FeatureFlags } from '@/lib/shared/types/settings'
import { searchChoice, searchId, searchText } from '@/lib/shared/search-params'

// Fields fall back instead of throwing. `category` feeds the article query's
// category id column, which throws on anything but a category TypeID.
// See lib/shared/search-params.ts.
const searchSchema = z.object({
  status: searchChoice(['draft', 'published']),
  category: searchId('category'),
  search: searchText(),
  sort: searchChoice(['newest', 'oldest']),
  deleted: z.boolean().optional().catch(undefined),
})

export const Route = createFileRoute('/admin/help-center')({
  validateSearch: searchSchema,
  component: HelpCenterLayout,
})

function HelpCenterLayout() {
  const { settings } = Route.useRouteContext()
  const flags = settings?.featureFlags as FeatureFlags | undefined
  if (!flags?.helpCenter) {
    return <Navigate to="/admin/feedback" />
  }

  return <Outlet />
}
