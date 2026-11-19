import type { ApprovalBroker } from '../approval'
import { siteOf } from './site'
import type { AutomationGate, PendingApproval } from './types'

/** How long a tool call waits for the user before reporting that the prompt is still open. */
export const DEFAULT_APPROVAL_WAIT_MS = 25_000

/**
 * Raised when the prompt for a site is still unanswered. The prompt stays open in the
 * browser, so the agent can ask the user to answer it and then repeat the call.
 */
export class ApprovalPendingError extends Error {
  constructor(site: string) {
    super(
      `Waiting for the user to answer the Agent control request for ${site}. The prompt is still open in the browser. Ask the user to answer it, then repeat this call. Do not try to approve it yourself.`
    )
    this.name = 'ApprovalPendingError'
  }
}

/**
 * Per-site consent, like the Claude for Chrome extension: the first time an agent acts
 * on a site the user is asked, and "Allow for this session" lasts until the browser
 * quits. A denial is not remembered, so the next action asks again.
 */
export class ApprovalGate implements AutomationGate {
  private readonly allowed = new Set<string>()
  private readonly inFlight = new Map<string, Promise<boolean>>()
  private readonly asked = new Map<string, { action: string; since: number }>()

  constructor(
    private readonly approvals: Pick<ApprovalBroker, 'request'>,
    private readonly options: { autoApprove?: boolean; waitMs?: number; now?: () => number } = {}
  ) {}

  async authorize(site: string, action: string): Promise<boolean> {
    if (this.options.autoApprove || this.allowed.has(site)) return true
    const decision = this.ask(site, action)
    const waitMs = this.options.waitMs ?? DEFAULT_APPROVAL_WAIT_MS
    if (waitMs <= 0) return decision

    let timer: ReturnType<typeof setTimeout> | undefined
    const stalled = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), waitMs)
    })
    try {
      const outcome = await Promise.race([decision, stalled])
      if (outcome === 'pending') throw new ApprovalPendingError(site)
      return outcome
    } finally {
      clearTimeout(timer)
    }
  }

  /** Prompts still waiting for the user, oldest first. */
  pending(): PendingApproval[] {
    return [...this.asked]
      .map(([site, entry]) => ({ site, action: entry.action, since: entry.since }))
      .sort((a, b) => a.since - b.since)
  }

  private ask(site: string, action: string): Promise<boolean> {
    const pending = this.inFlight.get(site)
    if (pending) return pending
    this.asked.set(site, { action, since: (this.options.now ?? Date.now)() })

    const asked = this.approvals
      .request({
        kind: 'automation',
        method: 'automation',
        action: `control ${site}`,
        service: site,
        origin: siteOf(site),
        identity: null,
        mode: 'none',
        note: site === 'browser://development'
          ? `Development access can inspect and operate browser settings and prompts. First action: ${action}`
          : `First action requested: ${action}`,
        rememberable: true,
        ephemeral: true,
        rememberLabel: 'Allow for this session'
      })
      .then((decision) => {
        if (decision.allow && decision.remember) this.allowed.add(site)
        return decision.allow
      })
      .finally(() => {
        this.inFlight.delete(site)
        this.asked.delete(site)
      })
    this.inFlight.set(site, asked)
    return asked
  }

  grants(): string[] {
    return [...this.allowed].sort()
  }

  revoke(site: string): void {
    this.allowed.delete(site)
  }

  /** Forget every session grant: the "stop agent" control. */
  revokeAll(): void {
    this.allowed.clear()
  }
}
