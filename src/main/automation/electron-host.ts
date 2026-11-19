import type { WebContents } from 'electron'
import type { BrowserShell } from '../shell'
import { keyEvents } from './key-events'
import type {
  AutomationContents,
  AutomationDiagnostic,
  AutomationHost,
  AutomationPage,
  PendingDialogInfo
} from './types'

const NAVIGATION_TIMEOUT_MS = 20_000
const MAX_DIAGNOSTICS = 300
const DIALOG_TIMEOUT_MS = 5 * 60_000

const MODIFIERS: Record<string, 'shift' | 'control' | 'alt' | 'meta'> = {
  shift: 'shift',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  meta: 'meta',
  cmd: 'meta'
}

type Collector = () => AutomationDiagnostic[]
const collectors = new WeakMap<WebContents, Collector>()

/**
 * Start (once per tab) buffering renderer console output and page load failures, and
 * return an accessor for what was captured so far.
 */
function watch(contents: WebContents): Collector {
  const existing = collectors.get(contents)
  if (existing) return existing

  const entries: AutomationDiagnostic[] = []
  const push = (entry: AutomationDiagnostic): void => {
    entries.push(entry)
    if (entries.length > MAX_DIAGNOSTICS) entries.splice(0, entries.length - MAX_DIAGNOSTICS)
  }

  contents.on('console-message', (event) => {
    const details = event as unknown as {
      level?: string
      message?: string
      lineNumber?: number
      sourceId?: string
    }
    const level = details.level
    push({
      time: new Date().toISOString(),
      kind: 'console',
      level: level === 'warning' || level === 'error' || level === 'debug' ? level : 'info',
      message: String(details.message ?? ''),
      url: details.sourceId ?? '',
      ...(typeof details.lineNumber === 'number' ? { line: details.lineNumber } : {})
    })
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === -3) return // aborted by a newer navigation
    push({
      time: new Date().toISOString(),
      kind: 'load-failure',
      level: 'error',
      message: `${isMainFrame ? 'Page' : 'Subframe'} failed to load: ${description} (${code})`,
      url
    })
  })

  const collector: Collector = () => entries.slice()
  collectors.set(contents, collector)
  return collector
}

interface PendingDialog extends PendingDialogInfo {
  resolve(answer: { accept: boolean; promptText?: string }): void
  timer: NodeJS.Timeout
}

const armed = new WeakSet<WebContents>()
const dialogs = new WeakMap<WebContents, PendingDialog>()

/**
 * Start intercepting alert/confirm/prompt via the Chrome DevTools Protocol, so an
 * authorized agent can see and answer them instead of the dialog silently blocking the
 * tab forever. Idempotent per tab; never armed until a tool call authorizes this tab, so
 * ordinary browsing with automation off is unaffected.
 */
function arm(contents: WebContents): void {
  if (armed.has(contents)) return
  armed.add(contents)
  try {
    contents.debugger.attach('1.3')
  } catch {
    // Already attached, e.g. real DevTools is open on this tab — leave native dialogs alone.
    armed.delete(contents)
    return
  }
  contents.debugger.sendCommand('Page.enable').catch(() => undefined)
  contents.debugger.on('message', (_event, method, params) => {
    if (method !== 'Page.javascriptDialogOpening') return
    const info = params as { type: PendingDialogInfo['type']; message: string; defaultPrompt?: string }
    const timer = setTimeout(() => {
      dialogs.delete(contents)
      contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => undefined)
    }, DIALOG_TIMEOUT_MS)
    dialogs.set(contents, {
      type: info.type,
      message: info.message,
      defaultValue: info.defaultPrompt ?? null,
      timer,
      resolve: (answer) => {
        contents.debugger
          .sendCommand('Page.handleJavaScriptDialog', {
            accept: answer.accept,
            promptText: answer.promptText
          })
          .catch(() => undefined)
      }
    })
  })
  contents.debugger.on('detach', () => {
    armed.delete(contents)
    const pending = dialogs.get(contents)
    if (pending) clearTimeout(pending.timer)
    dialogs.delete(contents)
  })
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
      const mods = modifiers.map((entry) => MODIFIERS[entry.toLowerCase()]).filter(Boolean)
      contents.focus()
      for (const event of keyEvents(key, modifiers)) {
        contents.sendInputEvent({ ...event, modifiers: mods })
      }
    },
    diagnostics,
    armDialogs: () => arm(contents),
    pendingDialog: () => {
      const pending = dialogs.get(contents)
      return pending
        ? { type: pending.type, message: pending.message, defaultValue: pending.defaultValue }
        : null
    },
    resolveDialog: (accept, promptText) => {
      const pending = dialogs.get(contents)
      if (!pending) return false
      clearTimeout(pending.timer)
      dialogs.delete(contents)
      pending.resolve({ accept, promptText })
      return true
    }
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
        .map(({ tabId, url, title, active }) => ({ tabId, url, title, active }))
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
    },
    chromeContents: () => {
      const contents = shell.window.webContents
      return contents.isDestroyed() ? null : wrap(contents)
    },
    openSettings: (section) => shell.openAutomationSettings(section)
  }
}
