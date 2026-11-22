import type { IpcMainInvokeEvent } from 'electron'
import type { LocatorCacheStore } from '../cache-store'
import type { EndpointHealth } from '../ncc/health'
import type { NccResolver } from '../ncc/resolver'
import type { PinStore } from '../pins'
import { browserShellFor, type BrowserShell } from '../shell'
import { isChromeSender } from '../ipc-guard'

export { isChromeSender }

/** The shell that sent an event, falling back to the primary window. */
export function shellForSender(event: IpcMainInvokeEvent, fallback: BrowserShell): BrowserShell {
  return browserShellFor(event.sender) ?? fallback
}

/** Everything needed to forget memoised resolution state. */
export interface CacheResettingDeps {
  resolvers: NccResolver[]
  cacheStore: LocatorCacheStore
  pins: PinStore
  health: EndpointHealth
}

/** Drop every memoised resolution after a settings or identity change. */
export function resetCaches(deps: CacheResettingDeps): void {
  for (const resolver of deps.resolvers) resolver.clearCache()
  deps.cacheStore.clear()
  deps.pins.clear()
  deps.health.clear()
}
