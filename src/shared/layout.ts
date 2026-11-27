/** Shared layout constants so the chrome and the content views never drift. */
import type { AppearanceConfig } from './types/settings'

export const TAB_STRIP_HEIGHT = 38
export const TOOLBAR_HEIGHT = 60
export const BOOKMARKS_BAR_HEIGHT = 34
export const SIDEBAR_WIDTH = 244
export const SIDEBAR_COLLAPSED_WIDTH = 48
export const BANNER_HEIGHT = 30

export type ChromeLayout = Pick<AppearanceConfig, 'tabLayout' | 'bookmarksBar' | 'sidebarCollapsed'>

/** How much of the window the chrome takes above and to the left of the page. */
export function chromeInsets(layout: ChromeLayout): { top: number; left: number } {
  if (layout.tabLayout === 'vertical') {
    return {
      top: TOOLBAR_HEIGHT,
      left: layout.sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH
    }
  }
  return {
    top: TAB_STRIP_HEIGHT + TOOLBAR_HEIGHT + (layout.bookmarksBar ? BOOKMARKS_BAR_HEIGHT : 0),
    left: 0
  }
}

/** What "show or hide bookmarks" changes, which depends on where the tabs are. */
export function toggleBookmarksPatch(layout: AppearanceConfig): Partial<AppearanceConfig> {
  if (layout.tabLayout === 'horizontal') return { bookmarksBar: !layout.bookmarksBar }
  // The icon strip shows no list, so the first press opens the sidebar on it.
  if (layout.sidebarCollapsed) return { sidebarCollapsed: false, sidebarBookmarks: true }
  return { sidebarBookmarks: !layout.sidebarBookmarks }
}
