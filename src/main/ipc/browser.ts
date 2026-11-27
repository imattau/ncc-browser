import { ipcMain } from 'electron'
import { COMMANDS, type CommandId } from '@shared/commands'
import { OVERLAY_REASONS } from '@shared/types'
import type { BrowserShell } from '../shell'
import { isChromeSender, shellForSender } from './shared'
import { normalizeHomeSite } from '@shared/home-sites'
import { createHomeShortcut } from '../home-shortcut'

export interface BrowserIpcDeps {
  shell: BrowserShell
}

/**
 * Navigation, tabs, per-tab history, bookmarks, window controls and chrome-only
 * commands. Every handler here acts on the shell that sent the event.
 */
export function registerBrowserIpc(deps: BrowserIpcDeps): void {
  const commandIds = new Set<string>(COMMANDS.map((command) => command.id))
  const overlayReasons = new Set<string>(OVERLAY_REASONS)
  const shellFor = (event: Electron.IpcMainInvokeEvent): BrowserShell =>
    shellForSender(event, deps.shell)
  const fromChrome = (event: Electron.IpcMainInvokeEvent): boolean => isChromeSender(event)

  ipcMain.handle('ncc:navigate', (event, input: unknown) => shellFor(event).navigate(String(input ?? '')))

  ipcMain.handle('ncc:back', (event) => shellFor(event).back())
  ipcMain.handle('ncc:forward', (event) => shellFor(event).forward())
  ipcMain.handle('ncc:reload', (event) => shellFor(event).reload())
  ipcMain.handle('ncc:force-reload', (event) => shellFor(event).forceReload())
  ipcMain.handle('ncc:stop', (event) => shellFor(event).stop())
  ipcMain.handle('ncc:toggle-tor', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).toggleTor()
  })
  ipcMain.handle('ncc:insecure-choice', (event, choice: unknown) => {
    if (!fromChrome(event)) return
    if (choice !== 'cancel' && choice !== 'continue' && choice !== 'always') return
    shellFor(event).insecureChoice(choice)
  })

  ipcMain.handle('ncc:new-tab', (event, input: unknown) =>
    shellFor(event).newTab(typeof input === 'string' ? input : undefined)
  )
  ipcMain.handle('ncc:new-private-tab', (event, input: unknown) => {
    if (!fromChrome(event)) return ''
    return shellFor(event).newPrivateTab(typeof input === 'string' ? input : undefined)
  })
  ipcMain.handle('ncc:new-tor-tab', (event, input: unknown) => {
    if (!fromChrome(event)) return ''
    return shellFor(event).newTorTab(typeof input === 'string' ? input : undefined)
  })
  ipcMain.handle('ncc:close-tab', (event, id: unknown) =>
    shellFor(event).closeTab(typeof id === 'string' ? id : undefined)
  )
  ipcMain.handle('ncc:select-tab', (event, id: unknown) => {
    if (typeof id === 'string') shellFor(event).selectTab(id)
  })
  ipcMain.handle('ncc:move-tab', (event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const { id, toIndex } = payload as { id?: unknown; toIndex?: unknown }
    if (typeof id !== 'string' || typeof toIndex !== 'number') return
    shellFor(event).moveTab(id, toIndex)
  })
  ipcMain.handle('ncc:detach-tab', (event, payload: unknown) => {
    if (!fromChrome(event) || !payload || typeof payload !== 'object') return
    const { id, screenX, screenY } = payload as { id?: unknown; screenX?: unknown; screenY?: unknown }
    if (typeof id !== 'string' || typeof screenX !== 'number' || typeof screenY !== 'number') return
    shellFor(event).detachTab(id, screenX, screenY)
  })
  ipcMain.handle('ncc:duplicate-tab', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).duplicateTab(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:reload-tab', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).reloadTab(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:toggle-mute', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).toggleMute(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:close-other-tabs', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).closeOtherTabs(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:close-tabs-right', (event, id: unknown) => {
    if (!fromChrome(event)) return
    shellFor(event).closeTabsToRight(typeof id === 'string' ? id : undefined)
  })
  ipcMain.handle('ncc:new-tab-menu', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).showNewTabMenu()
  })

  ipcMain.handle('ncc:tab-menu', (event, id: unknown) => {
    if (!fromChrome(event) || typeof id !== 'string') return
    shellFor(event).showTabMenu(id)
  })

  ipcMain.handle('ncc:tab-history', (event, id: unknown) =>
    shellFor(event).getTabHistory(typeof id === 'string' ? id : undefined)
  )
  ipcMain.handle('ncc:go-history-index', (event, index: unknown) => {
    if (!fromChrome(event) || typeof index !== 'number') return
    shellFor(event).goToHistoryIndex(index)
  })
  ipcMain.handle('ncc:clear-history', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).clearHistory()
  })
  ipcMain.handle('ncc:history-menu', (event, direction: unknown) => {
    if (!fromChrome(event)) return
    if (direction !== 'back' && direction !== 'forward') return
    shellFor(event).showHistoryMenu(direction)
  })

  ipcMain.handle('ncc:get-state', (event) => shellFor(event).getState())

  ipcMain.handle('ncc:create-home-shortcut', (event, value: unknown) => {
    if (!fromChrome(event)) return { ok: false, error: 'Only the browser window can create shortcuts.' }
    const site = normalizeHomeSite(value)
    if (!site) return { ok: false, error: 'This page address cannot be added as a shortcut.' }
    try {
      createHomeShortcut(site)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Could not create the desktop shortcut.' }
    }
  })

  ipcMain.handle('ncc:omnibox-suggest', (event, input: unknown) => {
    if (!fromChrome(event)) return []
    return shellFor(event).suggest(typeof input === 'string' ? input : '')
  })

  ipcMain.handle('ncc:clear-browsing-history', (event) => {
    if (!fromChrome(event)) return
    shellFor(event).clearBrowsingHistory()
  })

  ipcMain.handle('ncc:command', (event, command: unknown) => {
    if (!fromChrome(event)) return
    if (typeof command !== 'string' || !commandIds.has(command)) return
    shellFor(event).runCommand(command as CommandId)
  })

  ipcMain.handle('ncc:set-overlay', (event, payload: unknown) => {
    if (!fromChrome(event)) return
    if (!payload || typeof payload !== 'object') return
    const { reason, active } = payload as { reason?: unknown; active?: unknown }
    if (typeof reason !== 'string' || !overlayReasons.has(reason)) return
    shellFor(event).setOverlay(reason, active === true)
  })

  ipcMain.handle('ncc:bookmarks', (event) => shellFor(event).getBookmarks())

  ipcMain.handle('ncc:toggle-bookmark', (event) => {
    if (!fromChrome(event)) return []
    return shellFor(event).toggleBookmark()
  })

  ipcMain.handle('ncc:remove-bookmark', (event, url: unknown) => {
    if (!fromChrome(event) || typeof url !== 'string') return shellFor(event).getBookmarks()
    return shellFor(event).removeBookmark(url)
  })

  ipcMain.handle('ncc:bookmark-menu', (event, url: unknown) => {
    if (!fromChrome(event) || typeof url !== 'string') return
    shellFor(event).showBookmarkMenu(url)
  })

  ipcMain.handle('ncc:bookmark-list-menu', (event, fromIndex: unknown) => {
    if (!fromChrome(event) || !Number.isSafeInteger(fromIndex)) return
    shellFor(event).showBookmarkListMenu(fromIndex as number)
  })

  ipcMain.handle('ncc:window-minimize', (event) => {
    if (fromChrome(event)) shellFor(event).minimizeWindow()
  })
  ipcMain.handle('ncc:window-toggle-maximize', (event) => {
    if (fromChrome(event)) shellFor(event).toggleMaximizeWindow()
  })
  ipcMain.handle('ncc:window-close', (event) => {
    if (fromChrome(event)) shellFor(event).closeWindow()
  })
}
