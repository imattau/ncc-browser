/**
 * Strict mode for pages loaded over Tor: a Tor tab may only load .onion resources
 * (plus ncc:// and inert local schemes). Anything else could reveal the user's IP.
 */

import type { Session } from 'electron'

export function isOnionHost(hostname: string): boolean {
  return hostname === 'onion' || hostname.endsWith('.onion')
}

export function isAllowedTorUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  switch (url.protocol) {
    case 'ncc:':
    case 'data:':
    case 'blob:':
    case 'about:':
      return true
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:':
      return isOnionHost(url.hostname.toLowerCase())
    default:
      return false
  }
}

/**
 * A redirect from an onion endpoint may stay inside Tor (another onion host, the
 * current ncc address, or a relative URL) but must not jump to the clearnet.
 */
export function isAllowedTorRedirect(location: string, base: URL): boolean {
  let redirect: URL
  try {
    redirect = new URL(location, base)
  } catch {
    return true
  }
  if (redirect.protocol === 'ncc:') return true
  return (
    (redirect.protocol === 'http:' || redirect.protocol === 'https:') &&
    isOnionHost(redirect.hostname.toLowerCase())
  )
}

export class TorGuard {
  private readonly tabs = new Set<number>()

  set(webContentsId: number, active: boolean): void {
    if (active) this.tabs.add(webContentsId)
    else this.tabs.delete(webContentsId)
  }

  delete(webContentsId: number): void {
    this.tabs.delete(webContentsId)
  }

  isTor(webContentsId: number): boolean {
    return this.tabs.has(webContentsId)
  }

  clear(): void {
    this.tabs.clear()
  }

  install(session: Session, shouldBlock: (details: Electron.OnBeforeRequestListenerDetails) => boolean = () => false): void {
    session.webRequest.onBeforeRequest((details, callback) => {
      const id = details.webContentsId
      if (id !== undefined && this.tabs.has(id) && !isAllowedTorUrl(details.url)) {
        callback({ cancel: true })
        return
      }
      if (shouldBlock(details)) {
        callback({ cancel: true })
        return
      }
      callback({})
    })
  }
}
