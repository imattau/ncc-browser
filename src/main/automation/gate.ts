import type { ApprovalBroker } from '../approval'
import { siteOf } from './site'
import type { AutomationGate } from './types'

/**
 * Per-site consent, like the Claude for Chrome extension: the first time an agent acts
 * on a site the user is asked, and "Allow for this session" lasts until the browser
 * quits. A denial is not remembered, so the next action asks again.
 */
export class ApprovalGate implements AutomationGate {
  private readonly allowed = new Set<string>()
  private readonly inFlight = new Map<string, Promise<boolean>>()

  constructor(
    private readonly approvals: Pick<ApprovalBroker, 'request'>,
    private readonly options: { autoApprove?: boolean } = {}
  ) {}

  authorize(site: string, action: string): Promise<boolean> {
    if (this.options.autoApprove || this.allowed.has(site)) return Promise.resolve(true)
    const pending = this.inFlight.get(site)
    if (pending) return pending

    const asked = this.approvals
      .request({
        kind: 'automation',
        method: 'automation',
        action: `control ${site}`,
        service: site,
        origin: siteOf(site),
        identity: null,
        mode: 'none',
        note: `First action requested: ${action}`,
        rememberable: true,
        ephemeral: true,
        rememberLabel: 'Allow for this session'
      })
      .then((decision) => {
        if (decision.allow && decision.remember) this.allowed.add(site)
        return decision.allow
      })
      .finally(() => this.inFlight.delete(site))
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
