import { app } from 'electron'
import { browserShells } from '../shell'
import { closeSharedPool } from '../ncc/resolver'
import type { Runtime } from './runtime'

/** macOS can deliver a browser URL before the app is ready. */
export function installUrlOpener(runtime: Runtime): void {
  app.on('open-url', (event, url) => {
    event.preventDefault()
    if (!/^(https?):\/\//i.test(url)) return
    const target =
      browserShells()[0] ??
      (runtime.shell && !runtime.shell.window.isDestroyed() ? runtime.shell : null)
    if (target) void target.navigate(url)
    else runtime.pendingExternalUrl = url
  })
}

export function installWindowLifecycle(runtime: Runtime): void {
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    const target = browserShells()[0] ?? runtime.createFallbackShell?.() ?? null
    if (!target) return
    target.window.show()
    target.window.focus()
  })
}

/** Called after startup so the resource-owning services are already registered. */
export function installSecondInstance(runtime: Runtime): void {
  app.on('second-instance', (_event, argv) => {
    let target = browserShells()[0] ?? null
    if (!target && runtime.createFallbackShell) {
      target = runtime.createFallbackShell()
    }
    if (!target) return
    if (target.window.isMinimized()) target.window.restore()
    target.window.focus()
    const address = argv.find((arg) => /^(ncc|https?):\/\//i.test(arg))
    if (address) void target.navigate(address)
  })
}

export function installShutdown(runtime: Runtime): void {
  app.on('before-quit', () => {
    runtime.shell?.saveSessionNow()
    runtime.passwords?.dispose()
    runtime.walletService?.dispose()
    runtime.nwcService?.dispose()
    runtime.extensions?.dispose()
    void runtime.onionManager?.shutdown()
    runtime.tlsProxyManager?.shutdown()
    void runtime.portMappings?.removeAll()
    runtime.relaySync?.stop()
    closeSharedPool()
    void runtime.torManager?.stop()
    runtime.torRelays?.close()
  })
}
