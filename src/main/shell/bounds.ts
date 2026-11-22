import { screen } from 'electron'
import type { SavedWindow } from '../session-store'

/**
 * Restore the saved window size, but only restore the position when a meaningful part
 * of the window still lands on a connected display (monitors get unplugged).
 */
export function restoreWindowBounds(
  saved?: SavedWindow
): { width: number; height: number; x?: number; y?: number } {
  const width = saved?.width ?? 1280
  const height = saved?.height ?? 860
  if (!saved || saved.x === undefined || saved.y === undefined) return { width, height }

  const bounds = { x: saved.x, y: saved.y, width, height }
  const visible = screen.getAllDisplays().some((display) => {
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, display.workArea.x + display.workArea.width) -
        Math.max(bounds.x, display.workArea.x)
    )
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, display.workArea.y + display.workArea.height) -
        Math.max(bounds.y, display.workArea.y)
    )
    return overlapX * overlapY >= 100 * 100
  })

  return visible ? bounds : { width, height }
}
