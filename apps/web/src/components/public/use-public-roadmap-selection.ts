import { useCallback, useEffect } from 'react'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { Route } from '@/routes/_portal/roadmap.index'

/**
 * The roadmap the public board shows, read from and written to the address.
 *
 * `defaultRoadmapId` is written into the address when it names no roadmap, so
 * a shared link reopens the same view. That write must never replace the
 * visitor's next destination. This route's search changes only when a
 * navigation commits, but the router's location changes as soon as one
 * starts. Until a navigation away from the roadmap commits, the board stays
 * mounted and still reads an address with no roadmap. The old write ran on
 * every render in that window, so a render there (a query settling, a scroll)
 * replaced Home or Changelog with the roadmap (venturi-systems/feedback#369).
 * The default is therefore written only while the router is settled on this
 * page, checked again when the effect runs.
 */
export function usePublicRoadmapSelection(defaultRoadmapId: string | null = null): {
  selectedRoadmapId: string | null
  setSelectedRoadmap: (roadmapId: string | null) => void
} {
  const navigate = useNavigate()
  const router = useRouter()
  const search = Route.useSearch()
  const { roadmap } = search
  // Re-render when a navigation starts or settles, so the default is written
  // once the router has settled here and not while another address is pending.
  const settled = useRouterState({
    select: (state) => state.location.href === state.resolvedLocation?.href,
  })

  const setSelectedRoadmap = useCallback(
    (roadmapId: string | null): void => {
      void navigate({
        to: '/roadmap',
        // Choosing the view changes its scope, not the user's search or sort.
        search: { ...search, roadmap: roadmapId ?? undefined },
        replace: true,
      })
    },
    [navigate, search]
  )

  useEffect(() => {
    if (!defaultRoadmapId || roadmap || !settled) return
    // A navigation can start between this render and its effect, for example
    // a click on Home. Read the router now rather than the rendered value.
    const { location, resolvedLocation } = router.state
    if (location.href !== resolvedLocation?.href) return
    setSelectedRoadmap(defaultRoadmapId)
  }, [defaultRoadmapId, roadmap, settled, router, setSelectedRoadmap])

  return { selectedRoadmapId: roadmap ?? null, setSelectedRoadmap }
}
