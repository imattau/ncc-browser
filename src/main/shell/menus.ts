import { Menu, clipboard } from 'electron'
import type { Bookmark } from '@shared/types'
import type { BrowserShell } from '../shell'
import { historyLabel } from './format'

/** The `+` button's menu: the only place a normal tab user meets private and Tor. */
export function showNewTabMenu(shell: BrowserShell): void {
  Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => shell.newTab() },
    {
      label: 'New private tab',
      accelerator: 'CmdOrCtrl+Shift+N',
      click: () => shell.newPrivateTab()
    },
    {
      label: 'New Tor tab',
      accelerator: 'CmdOrCtrl+Shift+O',
      click: () => shell.newTorTab()
    }
  ]).popup({ window: shell.window })
}

/** Right-click (or long-press) jump list for the back/forward buttons. */
export function showHistoryMenu(shell: BrowserShell, direction: 'back' | 'forward'): void {
  const { entries, activeIndex } = shell.getTabHistory()
  const candidates =
    direction === 'back'
      ? entries.filter((entry) => entry.index < activeIndex).reverse()
      : entries.filter((entry) => entry.index > activeIndex)

  if (candidates.length === 0) return
  Menu.buildFromTemplate(
    candidates.map((entry) => ({
      label: historyLabel(entry.title, entry.url),
      click: () => shell.goToHistoryIndex(entry.index)
    }))
  ).popup({ window: shell.window })
}

/** Context menu for a bookmark. New tabs keep the current tab's kind by default. */
export function showBookmarkMenu(shell: BrowserShell, url: string): void {
  const kind = shell.getState().tabKind
  const sameKind = (): void => {
    if (kind === 'tor') shell.newTorTab(url)
    else if (kind === 'private') shell.newPrivateTab(url)
    else shell.newTab(url)
  }

  Menu.buildFromTemplate([
    { label: 'Open', click: () => void shell.navigate(url) },
    { label: 'Open in new tab', click: sameKind },
    { label: 'Open in new private tab', click: () => shell.newPrivateTab(url) },
    { label: 'Open in new Tor tab', click: () => shell.newTorTab(url) },
    { type: 'separator' },
    { label: 'Copy address', click: () => clipboard.writeText(url) },
    { type: 'separator' },
    { label: 'Remove bookmark', click: () => void shell.removeBookmark(url) }
  ]).popup({ window: shell.window })
}

/** Bookmarks that do not fit in the toolbar or the collapsed sidebar. */
export function showBookmarkListMenu(shell: BrowserShell, bookmarks: Bookmark[]): void {
  const items = bookmarks.slice(0, 40).map((bookmark) => ({
    // `&` marks a keyboard mnemonic in native menus.
    label: historyLabel(bookmark.title, bookmark.url).replace(/&/g, '&&'),
    click: () => void shell.navigate(bookmark.url)
  }))
  Menu.buildFromTemplate(
    items.length > 0
      ? [
          ...items,
          ...(bookmarks.length > items.length
            ? [{ label: `${bookmarks.length - items.length} more in the sidebar`, enabled: false }]
            : [])
        ]
      : [{ label: 'No bookmarks yet', enabled: false }]
  ).popup({ window: shell.window })
}

/** Context menu for a tab in the strip or sidebar. */
export function showTabMenu(shell: BrowserShell, id: string): void {
  const info = shell.tabMenuInfo(id)
  if (!info) return

  Menu.buildFromTemplate([
    { label: 'Reload', click: () => shell.reloadTab(id) },
    { label: 'Duplicate', click: () => void shell.duplicateTab(id) },
    { label: 'Open in new window', click: () => shell.openTabInNewWindow(id) },
    {
      label: info.muted ? 'Unmute tab' : 'Mute tab',
      click: () => shell.toggleMute(id)
    },
    { type: 'separator' },
    {
      label: 'Copy address',
      enabled: Boolean(info.displayUrl),
      click: () => clipboard.writeText(info.displayUrl)
    },
    { type: 'separator' },
    { label: 'Close tab', click: () => shell.closeTab(id) },
    {
      label: 'Close other tabs',
      enabled: info.count > 1,
      click: () => shell.closeOtherTabs(id)
    },
    {
      label: shell.tabsAreVertical() ? 'Close tabs below' : 'Close tabs to the right',
      enabled: info.index < info.count - 1,
      click: () => shell.closeTabsToRight(id)
    },
    ...(info.kind === 'normal'
      ? []
      : [
          { type: 'separator' as const },
          {
            label: info.kind === 'tor' ? 'Close all Tor tabs' : 'Close all private tabs',
            click: () => shell.closeTabsOfKind(info.kind)
          }
        ])
  ]).popup({ window: shell.window })
}
