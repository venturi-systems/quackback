import { useCallback, useEffect } from 'react'
import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import type { RoadmapId } from '@quackback/ids'
import { Route } from '@/routes/_portal/roadmap.index'

const ROADMAP_PATH = '/roadmap'

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
 * The default is therefore written only while the router is idle on this
 * page, checked again when the effect runs. Idle is the router's own status,
 * so no comparison of differently encoded addresses can hold the write back.
 */
export function usePublicRoadmapSelection(defaultRoadmapId: RoadmapId | null = null): {
  selectedRoadmapId: string | null
  setSelectedRoadmap: (roadmapId: string | null) => void
} {
  const navigate = useNavigate()
  const router = useRouter()
  const search = Route.useSearch()
  const { roadmap } = search
  // Re-render when a navigation starts or settles, so the default is written
  // once the router is idle here and not while another address is pending.
  const idle = useRouterState({ select: (state) => state.status === 'idle' })

  const setSelectedRoadmap = useCallback(
    (roadmapId: string | null): void => {
      void navigate({
        to: ROADMAP_PATH,
        // Choosing the view changes its scope, not the user's search or sort.
        search: { ...search, roadmap: roadmapId ?? undefined },
        replace: true,
      })
    },
    [navigate, search]
  )

  useEffect(() => {
    if (!defaultRoadmapId || roadmap || !idle) return
    // A navigation can start, or even settle, between this render and its
    // effect, for example a click on Home. Read the router now rather than the
    // rendered value, and write only while it is idle on the roadmap.
    const { status, location } = router.state
    if (status !== 'idle') return
    if (location.pathname.replace(/\/+$/, '') !== ROADMAP_PATH) return
    setSelectedRoadmap(defaultRoadmapId)
  }, [defaultRoadmapId, roadmap, idle, router, setSelectedRoadmap])

  return { selectedRoadmapId: roadmap ?? null, setSelectedRoadmap }
}
