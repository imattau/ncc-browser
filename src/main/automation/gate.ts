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

interface GrantTracking {
  allowed: Set<string>
  inFlight: Map<string, Promise<boolean>>
  asked: Map<string, { action: string; since: number }>
}

interface AskSpec extends GrantTracking {
  kind: 'automation' | 'automation-signer'
  /** First word(s) of the request's `action` field, e.g. "control" or "sign in to". */
  actionVerb: string
  identity: string | null
  note: string
  rememberLabel: string
}

/**
 * Per-site consent, like the Claude for Chrome extension: the first time an agent acts
 * on a site the user is asked, and "Allow for this session" lasts until the browser
 * quits. A denial is not remembered, so the next action asks again.
 *
 * Tracks two independent kinds of grant for the same agent: ordinary browsing
 * (`authorize`) and signing in via NIP-07 as the agent's own Nostr identity
 * (`authorizeSign`). Approving one never implies the other.
 */
export class ApprovalGate implements AutomationGate {
  readonly agentId?: string
  private readonly npub?: string
  private readonly browse: GrantTracking = {
    allowed: new Set(),
    inFlight: new Map(),
    asked: new Map()
  }
  private readonly sign: GrantTracking = {
    allowed: new Set(),
    inFlight: new Map(),
    asked: new Map()
  }

  constructor(
    private readonly approvals: Pick<ApprovalBroker, 'request'>,
    private readonly options: {
      autoApprove?: boolean
      waitMs?: number
      now?: () => number
      /** The agent this gate belongs to, so the request can be labelled and shown. */
      agentId?: string
      npub?: string
      identity?: () => { agentId: string; pubkey: string; npub: string } | null
    } = {}
  ) {
    this.agentId = options.agentId
    this.npub = options.npub
  }

  identity(): { agentId: string; pubkey: string; npub: string } | null {
    return this.options.identity?.() ?? null
  }

  async authorize(site: string, action: string): Promise<boolean> {
    return this.gate(site, action, {
      ...this.browse,
      kind: 'automation',
      actionVerb: 'control',
      identity: null,
      note:
        site === 'browser://development'
          ? `Development access can inspect and operate browser settings and prompts. First action: ${action}`
          : `First action requested: ${action}`,
      rememberLabel: 'Allow for this session'
    })
  }

  /** Like `authorize`, but for this agent signing in to `site` as its own Nostr identity. */
  async authorizeSign(site: string, action: string): Promise<boolean> {
    return this.gate(site, action, {
      ...this.sign,
      kind: 'automation-signer',
      actionVerb: 'sign in to',
      identity: this.npub ?? null,
      note: `This agent wants to sign in to ${site} using its own Nostr identity. First action: ${action}`,
      rememberLabel: 'Allow this agent to sign in here without asking'
    })
  }

  /** Prompts still waiting for the user, oldest first. */
  pending(): PendingApproval[] {
    return [...this.browse.asked]
      .map(([site, entry]) => ({ site, action: entry.action, since: entry.since }))
      .sort((a, b) => a.since - b.since)
  }

  grants(): string[] {
    return [...this.browse.allowed].sort()
  }

  revoke(site: string): void {
    this.browse.allowed.delete(site)
  }

  /** Forget every session grant: the "stop agent" control. */
  revokeAll(): void {
    this.browse.allowed.clear()
  }

  signGrants(): string[] {
    return [...this.sign.allowed].sort()
  }

  revokeSign(site: string): void {
    this.sign.allowed.delete(site)
  }

  /** Forget every sign-in grant: the "stop signing" control. */
  revokeAllSign(): void {
    this.sign.allowed.clear()
  }

  private async gate(site: string, action: string, spec: AskSpec): Promise<boolean> {
    if (this.options.autoApprove || spec.allowed.has(site)) return true
    const decision = this.ask(site, action, spec)
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

  private ask(site: string, action: string, spec: AskSpec): Promise<boolean> {
    const pending = spec.inFlight.get(site)
    if (pending) return pending
    spec.asked.set(site, { action, since: (this.options.now ?? Date.now)() })

    const asked = this.approvals
      .request({
        kind: spec.kind,
        method: 'automation',
        action: `${spec.actionVerb} ${site}`,
        service: site,
        origin: siteOf(site),
        identity: spec.identity,
        mode: 'none',
        note: spec.note,
        rememberable: true,
        ephemeral: true,
        rememberLabel: spec.rememberLabel
      })
      .then((decision) => {
        if (decision.allow && decision.remember) spec.allowed.add(site)
        return decision.allow
      })
      .finally(() => {
        spec.inFlight.delete(site)
        spec.asked.delete(site)
      })
    spec.inFlight.set(site, asked)
    return asked
  }
}
