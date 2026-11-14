/**
 * In-app approval broker. A NIP-07 request is forwarded to the chrome renderer, which
 * shows a modal over the whole window. The content view is hidden while the request is
 * pending, so the popup is real UI rather than a native dialog.
 */

import { randomUUID } from 'node:crypto'
import type { SignerDecision, SignerRequest } from '@shared/types'

export type ApprovalChannel = 'ncc:signer-request' | 'ncc:signer-resolved'

export interface ApprovalBrokerDeps {
  send(channel: ApprovalChannel, payload: unknown): boolean
  setOverlay(visible: boolean): void
  timeoutMs?: number
}

interface Pending {
  resolve(decision: SignerDecision): void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 120_000

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly timeoutMs: number

  constructor(private readonly deps: ApprovalBrokerDeps) {
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get pendingCount(): number {
    return this.pending.size
  }

  request(request: Omit<SignerRequest, 'id'>): Promise<SignerDecision> {
    const id = randomUUID()

    return new Promise<SignerDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(id, { allow: false, remember: false }, 'timeout')
      }, this.timeoutMs)

      this.pending.set(id, { resolve, timer })
      if (this.pending.size === 1) this.deps.setOverlay(true)

      const sent = this.deps.send('ncc:signer-request', { ...request, id })
      if (!sent) this.finish(id, { allow: false, remember: false }, 'unavailable')
    })
  }

  respond(id: string, decision: SignerDecision): void {
    this.finish(id, decision, 'answered')
  }

  /** Deny anything still queued, e.g. when the window closes. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.finish(id, { allow: false, remember: false }, 'cancelled')
    }
  }

  private finish(id: string, decision: SignerDecision, reason: string): void {
    const entry = this.pending.get(id)
    if (!entry) return

    clearTimeout(entry.timer)
    this.pending.delete(id)

    this.deps.send('ncc:signer-resolved', { id, reason })
    if (this.pending.size === 0) this.deps.setOverlay(false)

    entry.resolve(decision)
  }
}
