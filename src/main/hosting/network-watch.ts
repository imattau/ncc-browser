/**
 * Watch this machine's interface addresses for a changed prefix or DHCP lease.
 *
 * A published endpoint that hard-codes an old address stops working silently, so the
 * watcher reports old -> new pairs. Nothing is rewritten or republished automatically:
 * changing an endpoint and signing a new locator is a deliberate action.
 */

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { NetworkChange } from '@shared/reachability'

export interface NetworkWatchOptions {
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  intervalMs?: number
  now?: () => number
  onChange?: (change: NetworkChange) => void
  onSnapshot?: (changes: NetworkChange[]) => void
  maxChanges?: number
}

type Address = string

function isReportable(info: NetworkInterfaceInfo): boolean {
  if (info.internal) return false
  const address = info.address.split('%')[0].toLowerCase()
  if (info.family === 'IPv4') return !address.startsWith('169.254.')
  if (info.family === 'IPv6') {
    if (address.startsWith('fe8') || address.startsWith('fe9') || address.startsWith('fea') || address.startsWith('feb')) {
      return false
    }
    if (address.startsWith('fc') || address.startsWith('fd')) return false
    return /^[23]/.test(address)
  }
  return false
}

export class NetworkWatch {
  private readonly interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly maxChanges: number
  private timer: ReturnType<typeof setInterval> | null = null
  private snapshot = new Map<string, Address[]>()
  private changes: NetworkChange[] = []

  constructor(private readonly options: NetworkWatchOptions = {}) {
    this.interfaces = options.interfaces ?? networkInterfaces
    this.intervalMs = options.intervalMs ?? 60_000
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
    this.maxChanges = options.maxChanges ?? 20
  }

  start(): void {
    if (this.timer) return
    this.snapshot = this.collect()
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): NetworkChange[] {
    return this.changes.map((change) => ({ ...change }))
  }

  /** Compare now with the last snapshot; exposed for tests and manual checks. */
  tick(): NetworkChange[] {
    const next = this.collect()
    const found: NetworkChange[] = []
    const keys = new Set([...this.snapshot.keys(), ...next.keys()])
    for (const key of keys) {
      const [name, family] = key.split('|') as [string, 'ipv4' | 'ipv6']
      const before = this.snapshot.get(key) ?? []
      const after = next.get(key) ?? []
      const removed = before.filter((address) => !after.includes(address))
      const added = after.filter((address) => !before.includes(address))
      const count = Math.min(removed.length, added.length)
      for (let index = 0; index < count; index += 1) {
        const change: NetworkChange = {
          at: this.now(),
          interface: name,
          family,
          from: removed[index],
          to: added[index]
        }
        found.push(change)
        this.changes = [...this.changes, change].slice(-this.maxChanges)
        this.options.onChange?.(change)
      }
    }
    this.snapshot = next
    if (found.length) this.options.onSnapshot?.(this.list())
    return found
  }

  private collect(): Map<string, Address[]> {
    const result = new Map<string, Address[]>()
    for (const [name, addresses] of Object.entries(this.interfaces())) {
      for (const info of addresses ?? []) {
        if (!isReportable(info)) continue
        const family = info.family === 'IPv4' ? 'ipv4' : 'ipv6'
        const key = `${name}|${family}`
        const address = info.address.split('%')[0].toLowerCase()
        result.set(key, [...(result.get(key) ?? []), address])
      }
    }
    return result
  }
}
