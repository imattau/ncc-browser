import { ipcRenderer } from 'electron'
import { EXTENSION_SCHEME, type ExtensionManifest } from '@shared/extensions'

export interface ExtensionBridgeApi {
  readonly id: string
  readonly manifest: ExtensionManifest
  readonly i18n: Record<string, string>
  invoke(method: string, args: unknown[]): Promise<unknown>
  getURL(path: string): string
}

/** One bridge object per extension per world. */
export function createBridge(
  id: string,
  manifest: ExtensionManifest,
  i18n: Record<string, string> = {}
): ExtensionBridgeApi {
  return {
    id,
    manifest,
    i18n,
    invoke: (method, args) =>
      ipcRenderer.invoke('ext:invoke', { extensionId: id, method, args }),
    getURL: (path) => `${EXTENSION_SCHEME}://${id}/${String(path).replace(/^\/+/, '')}`
  }
}

/** Build the expression the preload evaluates inside an isolated world. */
export function dispatchExpression(kind: string, data: unknown): string {
  return `globalThis.__nccDispatch(${JSON.stringify(kind)}, ${JSON.stringify(data)})`
}
