/**
 * The roadmap the public board shows: the requested one when this viewer can
 * see it, otherwise the first available one.
 *
 * A roadmap id from the URL can name a roadmap that was deleted, made private,
 * or never existed. Each status column asks the server for that roadmap's
 * posts, and the server rejects a roadmap the viewer cannot see, so rendering
 * the columns for it would fail every column with a 500. The list the board
 * already holds is exactly the set the server accepts.
 */
export function resolveSelectedRoadmapId(
  requestedId: string | null | undefined,
  roadmaps: ReadonlyArray<{ id: string }>
): string | null {
  if (requestedId && roadmaps.some((roadmap) => roadmap.id === requestedId)) {
    return requestedId
  }
  return roadmaps[0]?.id ?? null
}
