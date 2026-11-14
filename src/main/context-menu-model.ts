/**
 * Pure description of a context menu, so ordering and enablement can be unit-tested
 * without Electron.
 */

export type ContextMenuActionId =
  | 'separator'
  | 'open-link'
  | 'copy-link'
  | 'open-image'
  | 'copy-image'
  | 'save-image'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'back'
  | 'forward'
  | 'reload'
  | 'inspect'

export interface ContextMenuAction {
  id: ContextMenuActionId
  label?: string
  enabled?: boolean
}

export interface ContextMenuInput {
  linkURL?: string
  srcURL?: string
  mediaType?: string
  isEditable?: boolean
  selectionText?: string
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * Context menu for remote content. The navigation entries are always present so a
 * right-click on empty space is still useful.
 */
export function describeContextMenu(input: ContextMenuInput): ContextMenuAction[] {
  const actions: ContextMenuAction[] = []
  const separator = (): void => {
    if (actions.length > 0 && actions[actions.length - 1].id !== 'separator') {
      actions.push({ id: 'separator' })
    }
  }

  if (input.linkURL) {
    actions.push(
      { id: 'open-link', label: 'Open Link in New Tab' },
      { id: 'copy-link', label: 'Copy Link Address' }
    )
    separator()
  }

  if (input.mediaType === 'image' && input.srcURL) {
    actions.push(
      { id: 'open-image', label: 'Open Image in New Tab' },
      { id: 'copy-image', label: 'Copy Image Address' },
      { id: 'save-image', label: 'Save Image As…' }
    )
    separator()
  }

  if (input.isEditable) {
    actions.push(
      { id: 'undo', label: 'Undo' },
      { id: 'redo', label: 'Redo' },
      { id: 'separator' },
      { id: 'cut', label: 'Cut' },
      { id: 'copy', label: 'Copy' },
      { id: 'paste', label: 'Paste' },
      { id: 'select-all', label: 'Select All' }
    )
    separator()
  } else if (input.selectionText?.trim()) {
    actions.push({ id: 'copy', label: 'Copy' })
    separator()
  }

  actions.push(
    { id: 'back', label: 'Back', enabled: input.canGoBack },
    { id: 'forward', label: 'Forward', enabled: input.canGoForward },
    { id: 'reload', label: 'Reload' },
    { id: 'separator' },
    { id: 'inspect', label: 'Inspect Element' }
  )

  return actions
}

/** The chrome UI only needs editing actions. */
export function describeChromeContextMenu(input: {
  isEditable?: boolean
  selectionText?: string
}): ContextMenuAction[] {
  if (input.isEditable) {
    return [
      { id: 'undo', label: 'Undo' },
      { id: 'redo', label: 'Redo' },
      { id: 'separator' },
      { id: 'cut', label: 'Cut' },
      { id: 'copy', label: 'Copy' },
      { id: 'paste', label: 'Paste' },
      { id: 'select-all', label: 'Select All' }
    ]
  }
  if (input.selectionText?.trim()) return [{ id: 'copy', label: 'Copy' }]
  return []
}
