import type { PageMode, TabKind } from '@shared/types'
import type { SavedSession, SavedTab, SavedWindowSession } from '../session-store'

export interface SessionTabView {
  id: string
  kind: TabKind
  mode: PageMode
  displayUrl: string
}

export interface WindowGeometry {
  width: number
  height: number
  x?: number
  y?: number
}

/**
 * Only normal tabs are persisted; private and Tor tabs must never come back after a
 * restart. A window with no normal tab still saves one blank tab so its layout
 * survives.
 */
export function savedWindowSession(
  tabs: SessionTabView[],
  activeId: string | null,
  bounds: WindowGeometry,
  maximized: boolean
): SavedWindowSession {
  const normalTabs = tabs.filter((tab) => tab.kind === 'normal')
  const savedTabs: SavedTab[] = normalTabs.length
    ? normalTabs.map((tab) => ({
        url: tab.mode === 'blank' ? '' : tab.displayUrl
      }))
    : [{ url: '' }]
  const activeIndex = Math.max(
    0,
    normalTabs.findIndex((tab) => tab.id === activeId)
  )
  return {
    tabs: savedTabs,
    activeIndex,
    window: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized
    }
  }
}

/** The tab list to recreate and the index that should be active. */
export function restoredTabPlan(session?: SavedSession | null): {
  tabs: SavedTab[]
  activeIndex: number
} {
  const tabs = session?.tabs?.length ? session.tabs : [{ url: '' }]
  const activeIndex = Math.min(
    Math.max(session?.activeIndex ?? 0, 0),
    Math.max(0, tabs.length - 1)
  )
  return { tabs, activeIndex }
}
