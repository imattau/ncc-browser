import type { IpcMainInvokeEvent } from 'electron'
import { browserShellFor } from './shell'

/**
 * True when an IPC sender is one of our chrome renderers rather than page content.
 * Page content has no general bridge, but a few channels are also reachable from the
 * content preload and must not act on the chrome's behalf.
 */
export function isChromeSender(event: IpcMainInvokeEvent): boolean {
  return browserShellFor(event.sender) !== null
}

/** Reject any sender that is not the trusted chrome. `label` names the feature. */
export function requireChrome(event: IpcMainInvokeEvent, label: string): void {
  if (!isChromeSender(event)) {
    throw new Error(`${label} is only available to the browser chrome`)
  }
}
