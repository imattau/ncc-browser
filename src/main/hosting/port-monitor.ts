/**
 * Watch mapped ports while Tor is already running.
 *
 * A mapping can expire or the service behind it can stop. Two consecutive failures
 * raise one alert; a later success clears it. The monitor never starts Tor by itself
 * and never opens a new mapping.
 */

import type { PortMapping, PortStatusEvent } from '@shared/reachability'
import { verifyTcpThroughSocks } from '../tor/onion'
import type { PortMappingService } from './port-mapping'

export interface PortMonitorOptions {
  mappings: Pick<PortMappingService, 'list' | 'reportCheck'>
  tor: { status: () => { ready: boolean; proxy: string | null } }
  probe?: (host: string, port: number, proxy: string | null, timeoutMs?: number) => Promise<boolean>
  intervalMs?: number
  failureThreshold?: number
  timeoutMs?: number
  now?: () => number
  onChange?: (event: PortStatusEvent) => void
}

export class PortMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private initial: ReturnType<typeof setTimeout> | null = null
  private checking = false
  private readonly states = new Map<number, 'ok' | 'failing'>()
  private readonly probe: NonNullable<PortMonitorOptions['probe']>
  private readonly now: () => number

  constructor(private readonly options: PortMonitorOptions) {
    this.probe = options.probe ?? verifyTcpThroughSocks
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  start(): void {
    if (this.timer) return
    this.initial = setTimeout(() => void this.check(), 30_000)
    this.initial.unref?.()
    this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? 10 * 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.initial) clearTimeout(this.initial)
    this.timer = null
    this.initial = null
  }

  async check(): Promise<PortStatusEvent[]> {
    if (this.checking) return []
    const status = this.options.tor.status()
    if (!status.ready || !status.proxy) return []
    const mappings = this.options.mappings.list()
    if (mappings.length === 0) return []
    this.checking = true
    const events: PortStatusEvent[] = []
    try {
      for (const mapping of mappings) {
        const ok = await this.probe(
          mapping.externalAddress,
          mapping.externalPort,
          status.proxy,
          this.options.timeoutMs ?? 20_000
        ).catch(() => false)
        const updated = this.options.mappings.reportCheck(
          mapping.localPort,
          ok,
          this.now()
        )
        if (!updated) continue
        const failing = (updated.failures ?? 0) >= (this.options.failureThreshold ?? 2)
        const state: 'ok' | 'failing' = failing ? 'failing' : 'ok'
        const previous = this.states.get(mapping.localPort)
        this.states.set(mapping.localPort, state)
        if (state === 'failing' || previous === 'failing') {
          const event: PortStatusEvent = { mapping: updated, state }
          events.push(event)
          this.options.onChange?.(event)
        }
      }
    } finally {
      this.checking = false
    }
    return events
  }

  /** Current in-memory state, for tests and diagnostics. */
  stateFor(localPort: number): 'ok' | 'failing' | undefined {
    return this.states.get(localPort)
  }
}

export type { PortMapping }
