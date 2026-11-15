/**
 * Keeps identity-resolved relays alive.
 *
 * An NCC-05 endpoint can rotate at any time, so each locator-backed entry is
 * re-resolved shortly before its record expires. The refresh point is jittered per
 * entry so several locators do not all burst-query at once. A failed refresh keeps
 * the previous address (a running relay is preferable to a broken one) and marks
 * the entry stale for the UI.
 */

import type { RelayEntry } from '@shared/types'

export interface RelaySyncDeps {
  entries: () => RelayEntry[]
  /** Re-resolve one entry; null when the locator is temporarily unusable. */
  refresh: (entry: RelayEntry) => Promise<RelayEntry | null>
  /** Persist the refreshed entry, keyed by its previous URL. */
  apply: (previousUrl: string, next: RelayEntry) => void
  markStale: (url: string, stale: boolean) => void
  /** Also refresh relays held outside the config, e.g. NIP-46 bunker relays. */
  refreshExtra?: () => Promise<void>
  onError?: (error: unknown) => void
  now?: () => number
  intervalMs?: number
  /** Jitter in seconds before expiry, 30–180 by default. */
  jitterSeconds?: () => number
}

export class RelaySync {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly jitterSeconds: () => number
  private readonly jitter = new Map<string, number>()
  private readonly inFlight = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: RelaySyncDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    this.intervalMs = deps.intervalMs ?? 60_000
    this.jitterSeconds =
      deps.jitterSeconds ?? (() => 30 + Math.floor(Math.random() * 150))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    // Do not hold the process open in tests or during shutdown.
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One pass; exposed for tests and for an explicit "refresh now". */
  async tick(): Promise<void> {
    const now = this.now()

    for (const entry of this.deps.entries()) {
      if (!entry.locator || this.inFlight.has(entry.url)) continue

      let jitter = this.jitter.get(entry.url)
      if (jitter === undefined) {
        jitter = this.jitterSeconds()
        this.jitter.set(entry.url, jitter)
      }
      if (now < entry.locator.expiresAt - jitter) continue

      this.inFlight.add(entry.url)
      try {
        const next = await this.deps.refresh(entry)
        if (!next) {
          this.deps.markStale(entry.url, true)
          continue
        }
        this.jitter.delete(entry.url)
        this.deps.apply(entry.url, { ...next, stale: false })
      } catch (error) {
        this.deps.markStale(entry.url, true)
        this.deps.onError?.(error)
      } finally {
        this.inFlight.delete(entry.url)
      }
    }

    try {
      await this.deps.refreshExtra?.()
    } catch (error) {
      this.deps.onError?.(error)
    }
  }
}
