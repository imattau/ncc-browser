import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { ExtensionPlanEntry } from '@shared/extensions'
import { createBridge, dispatchExpression } from './extension-bridge'
import { EXTENSION_SHIM } from './extension-shim'

/**
 * Content-script host. Runs in the existing isolated content preload, exposes a
 * private bridge per extension world and evaluates the packaged scripts there.
 */

interface RuntimeEntry {
  plan: ExtensionPlanEntry
  ready: Promise<void> | null
}

const entries = new Map<string, RuntimeEntry>()
const exposed = new Set<number>()

export function installExtensionRuntime(): void {
  let plan: ExtensionPlanEntry[]
  try {
    plan = ipcRenderer.sendSync('ext:plan', location.href) as ExtensionPlanEntry[]
  } catch {
    return
  }
  if (!Array.isArray(plan) || plan.length === 0) return

  for (const entry of plan) {
    entries.set(entry.extensionId, { plan: entry, ready: null })
    if (entry.css) {
      try {
        webFrame.insertCSS(entry.css)
      } catch {
        // A stylesheet failure must not stop the script from running.
      }
    }
    if (entry.runAt === 'document_start') {
      void ensure(entry)
    } else if (entry.runAt === 'document_end') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void ensure(entry), { once: true })
      } else {
        void ensure(entry)
      }
    } else if (document.readyState === 'complete') {
      void ensure(entry)
    } else {
      window.addEventListener('load', () => void ensure(entry), { once: true })
    }
  }

  ipcRenderer.on('ext:event', (event, payload: unknown) => {
    void handleEvent(event, payload)
  })
  ipcRenderer.on('ext:run', (event, payload: unknown) => {
    void handleRun(event, payload)
  })
}

async function handleEvent(event: Electron.IpcRendererEvent, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  const value = payload as {
    requestId?: unknown
    extensionId?: unknown
    kind?: unknown
    data?: unknown
  }
  if (typeof value.extensionId !== 'string') return
  const entry = entries.get(value.extensionId)
  if (!entry) {
    if (typeof value.requestId === 'string') {
      ipcRenderer.send('ext:event-result', {
        requestId: value.requestId,
        error: 'This extension does not run on this page'
      })
    }
    return
  }
  try {
    await ensure(entry.plan)
    const kind = typeof value.kind === 'string' ? value.kind : 'runtime.message'
    const result = await webFrame.executeJavaScriptInIsolatedWorld(entry.plan.worldId, [
      { code: dispatchExpression(kind, value.data) }
    ])
    if (typeof value.requestId === 'string') {
      ipcRenderer.send('ext:event-result', { requestId: value.requestId, result })
    }
  } catch (error) {
    if (typeof value.requestId === 'string') {
      ipcRenderer.send('ext:event-result', {
        requestId: value.requestId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

async function handleRun(event: Electron.IpcRendererEvent, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  const value = payload as {
    requestId?: unknown
    extensionId?: unknown
    code?: unknown
  }
  if (
    typeof value.requestId !== 'string' ||
    typeof value.extensionId !== 'string' ||
    typeof value.code !== 'string'
  ) {
    return
  }
  const entry = entries.get(value.extensionId)
  if (!entry) {
    ipcRenderer.send('ext:run-result', {
      requestId: value.requestId,
      error: 'This extension does not run on this page'
    })
    return
  }
  try {
    await ensure(entry.plan)
    const result = await webFrame.executeJavaScriptInIsolatedWorld(entry.plan.worldId, [
      { code: value.code }
    ])
    ipcRenderer.send('ext:run-result', { requestId: value.requestId, result })
  } catch (error) {
    ipcRenderer.send('ext:run-result', {
      requestId: value.requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function ensure(entry: ExtensionPlanEntry): Promise<void> {
  const record = entries.get(entry.extensionId)
  if (record?.ready) return record.ready
  const ready = expose(entry).then(() =>
    webFrame
      .executeJavaScriptInIsolatedWorld(entry.worldId, [
        { code: EXTENSION_SHIM },
        { code: entry.code }
      ])
      .then(() => undefined)
  )
  if (record) record.ready = ready
  return ready
}

function expose(entry: ExtensionPlanEntry): Promise<void> {
  if (exposed.has(entry.worldId)) return Promise.resolve()
  exposed.add(entry.worldId)
  contextBridge.exposeInIsolatedWorld(
    entry.worldId,
    '__nccExtensionBridge',
    createBridge(entry.extensionId, entry.manifest)
  )
  return Promise.resolve()
}
