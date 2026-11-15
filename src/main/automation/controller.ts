import type { AutomationState } from '@shared/automation'
import { ApprovalGate } from './gate'
import { AutomationServer } from './server'
import type { AutomationSettings } from './settings'
import type { AutomationHost } from './types'
import type { ApprovalBroker } from '../approval'

/** Default port, so a client keeps working across restarts. Falls back if taken. */
export const DEFAULT_AUTOMATION_PORT = 47821

export interface AutomationControllerDeps {
  settings: AutomationSettings
  host: AutomationHost
  approvals: Pick<ApprovalBroker, 'request'>
  version: string
  infoFile: string
  /** `NCC_AUTOMATION=1`: run regardless of the saved preference. */
  forced: boolean
  port?: number
  autoApprove?: boolean
  onChange(state: AutomationState): void
}

/** Owns the agent-control server's lifecycle and what Settings shows about it. */
export class AutomationController {
  private server: AutomationServer | null = null
  private readonly gate: ApprovalGate
  private error: string | null = null

  constructor(private readonly deps: AutomationControllerDeps) {
    this.gate = new ApprovalGate(deps.approvals, { autoApprove: deps.autoApprove === true })
  }

  state(): AutomationState {
    const token = this.deps.settings.token
    return {
      enabled: this.deps.settings.enabled,
      forced: this.deps.forced,
      running: this.server !== null,
      url: this.server?.url ?? null,
      tokenHint: token.slice(-4),
      grants: this.gate.grants(),
      error: this.error
    }
  }

  /** Start or stop to match the saved preference. */
  async sync(): Promise<void> {
    const wanted = this.deps.settings.enabled || this.deps.forced
    if (wanted && !this.server) await this.start()
    if (!wanted && this.server) this.stop()
    this.publish()
  }

  async setEnabled(value: boolean): Promise<AutomationState> {
    this.deps.settings.setEnabled(value)
    if (!value) this.gate.revokeAll()
    await this.sync()
    return this.state()
  }

  regenerateToken(): AutomationState {
    this.server?.setToken(this.deps.settings.regenerateToken())
    if (!this.server) this.deps.settings.regenerateToken()
    this.publish()
    return this.state()
  }

  revoke(site: string | null): AutomationState {
    if (site) this.gate.revoke(site)
    else this.gate.revokeAll()
    this.publish()
    return this.state()
  }

  /** The command that connects Claude Code to this browser, or null when not running. */
  connectCommand(): string | null {
    const url = this.server?.url
    if (!url) return null
    return `claude mcp add --transport http ncc-browser ${url} --header "Authorization: Bearer ${this.deps.settings.token}"`
  }

  shutdown(): void {
    this.stop()
  }

  private async start(): Promise<void> {
    const server = new AutomationServer({
      host: this.deps.host,
      gate: this.gate,
      version: this.deps.version,
      infoFile: this.deps.infoFile,
      token: this.deps.settings.token,
      port: this.deps.port ?? DEFAULT_AUTOMATION_PORT
    })
    try {
      await server.start()
      this.server = server
      this.error = null
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
  }

  private stop(): void {
    this.server?.stop()
    this.server = null
  }

  private publish(): void {
    this.deps.onChange(this.state())
  }
}
