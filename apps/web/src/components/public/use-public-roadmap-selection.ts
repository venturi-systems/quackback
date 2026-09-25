import { useNavigate } from '@tanstack/react-router'
import { Route } from '@/routes/_portal/roadmap.index'

export function usePublicRoadmapSelection(): {
  selectedRoadmapId: string | null
  setSelectedRoadmap: (roadmapId: string | null) => void
} {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const { roadmap } = search

  function setSelectedRoadmap(roadmapId: string | null): void {
    void navigate({
      to: '/roadmap',
      // Choosing the view changes its scope, not the user's search or sort.
      search: { ...search, roadmap: roadmapId ?? undefined },
      replace: true,
    })
  }

  return { selectedRoadmapId: roadmap ?? null, setSelectedRoadmap }
}
