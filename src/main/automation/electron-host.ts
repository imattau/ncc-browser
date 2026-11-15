import type { WebContents } from 'electron'
import type { BrowserShell } from '../shell'
import type {
  AutomationContents,
  AutomationDiagnostic,
  AutomationHost,
  AutomationPage
} from './types'

const NAVIGATION_TIMEOUT_MS = 20_000
const MAX_DIAGNOSTICS = 300

const MODIFIERS: Record<string, 'shift' | 'control' | 'alt' | 'meta'> = {
  shift: 'shift',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  meta: 'meta',
  cmd: 'meta'
}

const KEY_CODES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

const watched = new WeakMap<WebContents, AutomationDiagnostic[]>()

function watch(contents: WebContents): AutomationDiagnostic[] {
  const existing = watched.get(contents)
  if (existing) return existing
  const entries: AutomationDiagnostic[] = []
  const add = (entry: AutomationDiagnostic): void => {
    entries.push(entry)
    if (entries.length > MAX_DIAGNOSTICS) entries.splice(0, entries.length - MAX_DIAGNOSTICS)
  }
  contents.on('console-message', (event) => {
    const level = event.level
    add({
      time: new Date().toISOString(),
      kind: 'console',
      level: level === 'warning' || level === 'error' || level === 'debug' ? level : 'info',
      message: event.message,
      url: event.sourceId,
      line: event.lineNumber
    })
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // Ignore aborted navigations.
    add({
      time: new Date().toISOString(),
      kind: 'load-failure',
      level: 'error',
      message: `${description} (${code})`,
      url
    })
  })
  watched.set(contents, entries)
  return entries
}

function wrap(contents: WebContents): AutomationContents {
  const diagnostics = watch(contents)
  const mouse = (type: 'mouseMove' | 'mouseDown' | 'mouseUp', x: number, y: number, extra = {}) =>
    contents.sendInputEvent({ type, x, y, ...extra })

  return {
    evaluate: (code) => contents.executeJavaScript(code, true),
    screenshot: async () => (await contents.capturePage()).toPNG(),
    click: async (x, y, options = {}) => {
      const button = options.button ?? 'left'
      const clickCount = options.clickCount ?? 1
      contents.focus()
      mouse('mouseMove', x, y)
      for (let count = 1; count <= clickCount; count++) {
        mouse('mouseDown', x, y, { button, clickCount: count })
        mouse('mouseUp', x, y, { button, clickCount: count })
      }
    },
    hover: async (x, y) => {
      mouse('mouseMove', x, y)
    },
    insertText: async (value) => {
      contents.focus()
      await contents.insertText(value)
    },
    pressKey: async (key, modifiers) => {
      const keyCode = KEY_CODES[key.toLowerCase()] ?? key
      const mods = modifiers.map((entry) => MODIFIERS[entry.toLowerCase()]).filter(Boolean)
      contents.focus()
      contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods })
      if (keyCode.length === 1 && !mods.some((entry) => entry === 'control' || entry === 'meta')) {
        contents.sendInputEvent({ type: 'char', keyCode, modifiers: mods })
      }
      contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods })
    },
    diagnostics: () => [...diagnostics]
  }
}

/** Resolves once the page stops loading, or after a timeout so a slow site cannot hang a call. */
function settled(contents: WebContents): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      contents.removeListener('did-stop-loading', done)
      contents.removeListener('destroyed', done)
      resolve()
    }
    const timer = setTimeout(done, NAVIGATION_TIMEOUT_MS)
    contents.once('did-stop-loading', done)
    contents.once('destroyed', done)
  })
}

export function createElectronHost(shell: BrowserShell): AutomationHost {
  const live = (tabId: string): WebContents | null => shell.automationContents(tabId)
  const observeTabs = (): void => {
    for (const page of shell.extensionPages()) {
      if (page.kind === 'normal') {
        const contents = shell.automationContents(page.tabId)
        if (contents) watch(contents)
      }
    }
  }

  // Begin collecting for tabs already open; listTabs catches tabs opened later.
  observeTabs()

  return {
    listTabs: (): AutomationPage[] => {
      observeTabs()
      return shell
        .extensionPages()
        .filter((page) => page.kind === 'normal')
        .map(({ tabId, url, title, active }) => ({ tabId, url, title, active })),
    },
    newTab: (url) => {
      const tabId = shell.newTab(url)
      const contents = live(tabId)
      if (contents) watch(contents)
      return tabId
    },
    closeTab: (tabId) => shell.closeTab(tabId),
    selectTab: (tabId) => shell.selectTab(tabId),
    navigate: async (tabId, input) => {
      const contents = live(tabId)
      if (!contents) return
      // Register before starting so a fast load is not missed.
      const wait = settled(contents)
      shell.navigateTab(tabId, input)
      await wait
    },
    history: async (tabId, direction) => {
      const contents = live(tabId)
      if (!contents) return
      const wait = settled(contents)
      if (direction === 'back') contents.navigationHistory.goBack()
      else contents.navigationHistory.goForward()
      await wait
    },
    contents: (tabId) => {
      const contents = live(tabId)
      return contents ? wrap(contents) : null
    }
  }
}
