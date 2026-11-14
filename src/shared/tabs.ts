/** Tab ordering helpers shared by the shell and the renderer. */

/**
 * Move `id` to `toIndex`, where the index is measured in the list *before* the move.
 * Dropping a tab on the right edge of the strip (`toIndex === tabs.length`) appends it.
 */
export function reorderTabs<T extends { id: string }>(
  tabs: readonly T[],
  id: string,
  toIndex: number
): T[] {
  const from = tabs.findIndex((tab) => tab.id === id)
  if (from === -1) return [...tabs]

  const next = [...tabs]
  const [moved] = next.splice(from, 1)
  const target = Number.isFinite(toIndex) ? Math.trunc(toIndex) : next.length
  const insertAt = Math.min(Math.max(target > from ? target - 1 : target, 0), next.length)
  next.splice(insertAt, 0, moved)
  return next
}
