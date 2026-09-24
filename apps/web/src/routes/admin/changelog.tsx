import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { ChangelogList, ChangelogModal } from '@/components/admin/changelog'
import { searchChoice, searchText } from '@/lib/shared/search-params'

// Fields fall back instead of throwing. See lib/shared/search-params.ts.
const searchSchema = z.object({
  status: searchChoice(['draft', 'scheduled', 'published']),
  entry: searchText(), // Entry ID for modal view
  search: searchText(),
})

export const Route = createFileRoute('/admin/changelog')({
  validateSearch: searchSchema,
  component: ChangelogPage,
})

function ChangelogPage() {
  const search = Route.useSearch()

  return (
    <main className="h-full">
      <ChangelogList />
      <ChangelogModal entryId={search.entry} />
    </main>
  )
}
