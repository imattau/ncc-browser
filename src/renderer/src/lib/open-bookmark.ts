import type { MouseEvent } from 'react'
import type { TabKind } from '@shared/types'

export interface BookmarkActions {
  onOpen: (url: string) => void
  /** Opens in a new tab of the current tab's kind, so a Tor tab never leaks. */
  onOpenInNewTab: (url: string) => void
  onContextMenu: (url: string) => void
}

export function openInNewTabOfKind(url: string, kind: TabKind): Promise<string> {
  if (kind === 'tor') return window.ncc.newTorTab(url)
  if (kind === 'private') return window.ncc.newPrivateTab(url)
  return window.ncc.newTab(url)
}

/** Click opens here; middle-click or Ctrl/⌘-click opens a tab; right-click is a menu. */
export function bookmarkProps(url: string, { onOpen, onOpenInNewTab, onContextMenu }: BookmarkActions) {
  return {
    'data-bookmark-url': url,
    onClick: (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey) onOpenInNewTab(url)
      else onOpen(url)
    },
    // Stops the middle-button autoscroll cursor.
    onMouseDown: (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault()
    },
    onAuxClick: (event: MouseEvent) => {
      if (event.button === 1) onOpenInNewTab(url)
    },
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault()
      onContextMenu(url)
    }
  }
}
