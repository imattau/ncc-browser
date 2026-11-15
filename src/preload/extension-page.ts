import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { ExtensionManifest } from '@shared/extensions'
import { createBridge, dispatchExpression } from './extension-bridge'
import { EXTENSION_SHIM } from './extension-shim'

/**
 * Preload for `ncc-ext://<id>/…` pages, including the hidden background page,
 * popups and options. These are extension code, not web pages: the shim and bridge
 * are exposed directly in the main world, but Node and the chrome UI stay out.
 */

export function installExtensionPage(): void {
  const id = location.hostname.toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(id)) return
  const manifest = ipcRenderer.sendSync('ext:manifest', id) as ExtensionManifest | null
  if (!manifest) return

  contextBridge.exposeInMainWorld(
    '__nccExtensionBridge',
    createBridge(id, manifest, readMessages(manifest))
  )
  void webFrame.executeJavaScript(EXTENSION_SHIM).catch(() => undefined)

  ipcRenderer.on('ext:event', (event, payload: unknown) => {
    void handleEvent(event, payload)
  })
  ipcRenderer.on('ext:run', (event, payload: unknown) => {
    void handleRun(event, payload)
  })
}

async function handleEvent(event: Electron.IpcRendererEvent, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  const value = payload as { requestId?: unknown; kind?: unknown; data?: unknown }
  try {
    const kind = typeof value.kind === 'string' ? value.kind : 'runtime.message'
    const result = await webFrame.executeJavaScript(dispatchExpression(kind, value.data))
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
  const value = payload as { requestId?: unknown; code?: unknown }
  if (typeof value.requestId !== 'string' || typeof value.code !== 'string') return
  try {
    const result = await webFrame.executeJavaScript(value.code)
    ipcRenderer.send('ext:run-result', { requestId: value.requestId, result })
  } catch (error) {
    ipcRenderer.send('ext:run-result', {
      requestId: value.requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function readMessages(_manifest: ExtensionManifest): Record<string, string> {
  // Locale files are read by the main process in a later milestone; an empty map
  // keeps chrome.i18n.getMessage safe for now.
  return {}
}
