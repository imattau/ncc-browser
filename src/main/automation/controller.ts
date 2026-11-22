import type { AgentSummary, AutomationState } from '@shared/automation'
import { ApprovalGate } from './gate'
import { AutomationServer, type ServerAgent } from './server'
import type { AgentRecord, AutomationSettings } from './settings'
import type { AutomationHost } from './types'
import type { ApprovalBroker } from '../approval'

/** Default port, so a client keeps working across restarts. Falls back if taken. */
export const DEFAULT_AUTOMATION_PORT = 47821

export interface AutomationPasswordsLike {
  status(): { unlocked: boolean }
  saveAgentSecret(id: string, name: string, npub: string, nsec: string): Promise<{ ok: boolean; error?: string }>
  removeEntry(id: string): Promise<unknown>
}

export interface AutomationControllerDeps {
  settings: AutomationSettings
  host: AutomationHost
  approvals: Pick<ApprovalBroker, 'request'>
  passwords: AutomationPasswordsLike
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
  private readonly gates = new Map<string, ApprovalGate>()
  private error: string | null = null

  constructor(private readonly deps: AutomationControllerDeps) {}

  state(): AutomationState {
    return {
      enabled: this.deps.settings.enabled,
      forced: this.deps.forced,
      running: this.server !== null,
      url: this.server?.url ?? null,
      agents: this.deps.settings.agents.map((agent) => this.summarize(agent)),
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
    if (!value) for (const gate of this.gates.values()) gate.revokeAll()
    await this.sync()
    return this.state()
  }

  /**
   * Creates a new agent with its own Nostr identity and stores its nsec in the password
   * vault (the vault must be unlocked). Returns the one-time, unmasked connect command
   * alongside the usual state — the nsec never appears in `state()` again after this.
   */
  async addAgent(name: string): Promise<{ state: AutomationState; command: string | null; error: string | null }> {
    if (!this.deps.passwords.status().unlocked) {
      return { state: this.state(), command: null, error: 'Unlock the password manager first.' }
    }
    const agent = this.deps.settings.addAgent(name.trim() || 'Agent')
    const saved = await this.deps.passwords.saveAgentSecret(agent.id, agent.name, agent.npub ?? '', agent.nsec)
    if (!saved.ok) {
      this.deps.settings.removeAgent(agent.id)
      return { state: this.state(), command: null, error: saved.error ?? 'Could not store the agent credential.' }
    }
    this.deps.settings.setPasswordEntryId(agent.id, agent.id)
    this.server?.refresh()
    this.publish()
    return { state: this.state(), command: this.connectCommand(agent.id, false), error: null }
  }

  removeAgent(id: string): AutomationState {
    const agent = this.deps.settings.agent(id)
    this.deps.settings.removeAgent(id)
    this.gates.delete(id)
    if (agent?.passwordEntryId && this.deps.passwords.status().unlocked) {
      void this.deps.passwords.removeEntry(agent.passwordEntryId).catch(() => undefined)
    }
    this.server?.refresh()
    this.publish()
    return this.state()
  }

  /** Replaces an agent's keypair; its old nsec stops authorizing immediately. */
  async regenerateIdentity(id: string): Promise<{ state: AutomationState; command: string | null; error: string | null }> {
    const agent = this.deps.settings.regenerateIdentity(id)
    if (!agent) return { state: this.state(), command: null, error: 'That agent no longer exists.' }
    this.gates.get(id)?.revokeAll()
    if (agent.passwordEntryId && this.deps.passwords.status().unlocked) {
      await this.deps.passwords.saveAgentSecret(agent.id, agent.name, agent.npub ?? '', agent.nsec)
    }
    this.server?.refresh()
    this.publish()
    return { state: this.state(), command: this.connectCommand(id, false), error: null }
  }

  /** Requires the password vault to be unlocked, mirroring a saved password's reveal. */
  revealCommand(id: string): string | null {
    if (!this.deps.passwords.status().unlocked) return null
    return this.connectCommand(id, false)
  }

  revoke(agentId: string, site: string | null): AutomationState {
    const gate = this.gates.get(agentId)
    if (gate) {
      if (site) gate.revoke(site)
      else gate.revokeAll()
    }
    this.publish()
    return this.state()
  }

  shutdown(): void {
    this.stop()
  }

  private async start(): Promise<void> {
    const server = new AutomationServer({
      host: this.deps.host,
      version: this.deps.version,
      infoFile: this.deps.infoFile,
      port: this.deps.port ?? DEFAULT_AUTOMATION_PORT,
      agents: () => this.serverAgents()
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

  private serverAgents(): ServerAgent[] {
    return this.deps.settings.agents.map((agent) => ({
      id: agent.id,
      nsec: agent.nsec,
      gate: this.gateFor(agent.id)
    }))
  }

  private gateFor(id: string): ApprovalGate {
    let gate = this.gates.get(id)
    if (!gate) {
      gate = new ApprovalGate(this.deps.approvals, { autoApprove: this.deps.autoApprove === true })
      this.gates.set(id, gate)
    }
    return gate
  }

  private summarize(agent: AgentRecord): AgentSummary {
    return {
      id: agent.id,
      name: agent.name,
      npub: agent.npub,
      passwordEntryId: agent.passwordEntryId,
      grants: this.gateFor(agent.id).grants(),
      maskedCommand: this.connectCommand(agent.id, true)
    }
  }

  /** The command that connects an MCP client to this browser as this agent. */
  private connectCommand(agentId: string, masked: boolean): string | null {
    const url = this.server?.url
    const agent = this.deps.settings.agent(agentId)
    if (!url || !agent) return null
    const bearer = masked ? `${agent.nsec.slice(0, 9)}${'•'.repeat(8)}` : agent.nsec
    return `claude mcp add --transport http ncc-browser ${url} --header "Authorization: Bearer ${bearer}"`
  }

  private publish(): void {
    this.deps.onChange(this.state())
  }
}
