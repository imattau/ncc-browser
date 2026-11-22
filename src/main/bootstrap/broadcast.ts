import type { Runtime } from './runtime'

/** The primary chrome window, if it exists and is still alive. */
export function chromeShell(runtime: Runtime) {
  const shell = runtime.shell
  return shell && !shell.window.isDestroyed() ? shell : null
}

/**
 * Send a state update to the primary window. Services use this from their `onChange`
 * callbacks, which can fire before the window exists or after it closes.
 */
export function broadcastToChrome(runtime: Runtime, channel: string, payload: unknown): void {
  chromeShell(runtime)?.sendToChrome(channel, payload)
}
