/**
 * Native context menus for remote content and the chrome UI.
 */

import {
  Menu,
  clipboard,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import {
  describeChromeContextMenu,
  describeContextMenu,
  type ContextMenuAction
} from './context-menu-model'

export interface ContentContextMenuDeps {
  getWindow: () => BrowserWindow | null
  openInNewTab: (url: string) => void
}

export function installContentContextMenu(
  contents: WebContents,
  deps: ContentContextMenuDeps
): void {
  contents.on('context-menu', (_event, params) => {
    const history = contents.navigationHistory
    const actions = describeContextMenu({
      linkURL: params.linkURL || undefined,
      srcURL: params.srcURL || undefined,
      mediaType: params.mediaType,
      isEditable: params.isEditable,
      selectionText: params.selectionText,
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward()
    })

    const template = actions.map((action) =>
      toMenuItem(action, contents, params.linkURL, params.srcURL, params.x, params.y, deps)
    )
    Menu.buildFromTemplate(template).popup({ window: deps.getWindow() ?? undefined })
  })
}

export function installChromeContextMenu(
  contents: WebContents,
  getWindow: () => BrowserWindow | null
): void {
  contents.on('context-menu', (_event, params) => {
    const actions = describeChromeContextMenu({
      isEditable: params.isEditable,
      selectionText: params.selectionText
    })
    if (actions.length === 0) return

    const template = actions.map((action) =>
      toMenuItem(action, contents, '', '', params.x, params.y, {
        getWindow,
        openInNewTab: () => undefined
      })
    )
    Menu.buildFromTemplate(template).popup({ window: getWindow() ?? undefined })
  })
}

function toMenuItem(
  action: ContextMenuAction,
  contents: WebContents,
  linkURL: string,
  srcURL: string,
  x: number,
  y: number,
  deps: ContentContextMenuDeps
): MenuItemConstructorOptions {
  switch (action.id) {
    case 'separator':
      return { type: 'separator' }
    case 'open-link':
      return { label: action.label, click: () => deps.openInNewTab(linkURL) }
    case 'copy-link':
      return { label: action.label, click: () => clipboard.writeText(linkURL) }
    case 'open-image':
      return { label: action.label, click: () => deps.openInNewTab(srcURL) }
    case 'copy-image':
      return { label: action.label, click: () => clipboard.writeText(srcURL) }
    case 'save-image':
      return { label: action.label, click: () => contents.downloadURL(srcURL) }
    case 'undo':
      return { role: 'undo' }
    case 'redo':
      return { role: 'redo' }
    case 'cut':
      return { role: 'cut' }
    case 'copy':
      return { role: 'copy' }
    case 'paste':
      return { role: 'paste' }
    case 'select-all':
      return { role: 'selectAll' }
    case 'back':
      return {
        label: action.label,
        enabled: action.enabled !== false,
        click: () => contents.navigationHistory.goBack()
      }
    case 'forward':
      return {
        label: action.label,
        enabled: action.enabled !== false,
        click: () => contents.navigationHistory.goForward()
      }
    case 'reload':
      return { label: action.label, click: () => contents.reload() }
    case 'inspect':
      return { label: action.label, click: () => contents.inspectElement(x, y) }
    default:
      return { label: action.label }
  }
}
