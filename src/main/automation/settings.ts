import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateSecretKey } from 'nostr-tools'
import { hexPubkeyOf, npubOf, nsecOf } from '../signer/crypto'

/**
 * One agent that may connect to the agent-control server. Its nsec *is* its bearer
 * credential — the same value goes in the MCP client's `Authorization: Bearer …` header
 * and is what `server.ts` matches requests against. `pubkey`/`npub` are null only for an
 * agent migrated from before per-agent identities existed, until it is regenerated.
 */
export interface AgentRecord {
  id: string
  name: string
  nsec: string
  pubkey: string | null
  npub: string | null
  /** The password-vault entry holding this agent's nsec, once it has been stored there. */
  passwordEntryId: string | null
  createdAt: number
}

interface SettingsFile {
  enabled: boolean
  agents: AgentRecord[]
}

/**
 * Agent-control preferences, kept apart from the main config so the feature is
 * self-contained. Each agent's nsec is stable across restarts so a client only connects
 * once; the file is user-only (0600).
 */
export class AutomationSettings {
  private data: SettingsFile | null = null

  constructor(private readonly filePath: string) {}

  get enabled(): boolean {
    return this.load().enabled
  }

  get agents(): AgentRecord[] {
    return this.load().agents
  }

  agent(id: string): AgentRecord | undefined {
    return this.load().agents.find((candidate) => candidate.id === id)
  }

  setEnabled(value: boolean): void {
    this.load().enabled = value
    this.save()
  }

  addAgent(name: string): AgentRecord {
    const agent: AgentRecord = { id: randomUUID(), name, ...freshIdentity(), passwordEntryId: null, createdAt: now() }
    this.load().agents.push(agent)
    this.save()
    return agent
  }

  removeAgent(id: string): void {
    const data = this.load()
    const next = data.agents.filter((candidate) => candidate.id !== id)
    if (next.length === data.agents.length) return
    data.agents = next
    this.save()
  }

  renameAgent(id: string, name: string): AgentRecord | undefined {
    const agent = this.agent(id)
    if (!agent) return undefined
    agent.name = name
    this.save()
    return agent
  }

  setPasswordEntryId(id: string, passwordEntryId: string | null): void {
    const agent = this.agent(id)
    if (!agent) return
    agent.passwordEntryId = passwordEntryId
    this.save()
  }

  /** Replaces an agent's keypair, invalidating any client still using its old nsec. */
  regenerateIdentity(id: string): AgentRecord | undefined {
    const agent = this.agent(id)
    if (!agent) return undefined
    Object.assign(agent, freshIdentity())
    this.save()
    return agent
  }

  private load(): SettingsFile {
    if (this.data) return this.data
    let parsed: Partial<SettingsFile> & { token?: unknown } = {}
    try {
      if (existsSync(this.filePath)) parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch {
      parsed = {}
    }

    let agents: AgentRecord[]
    let dirty = false
    if (Array.isArray(parsed.agents)) {
      agents = parsed.agents.filter(isAgentRecord)
      dirty = agents.length !== parsed.agents.length
    } else if (typeof parsed.token === 'string' && /^[0-9a-f]{64}$/.test(parsed.token)) {
      // Legacy single-agent file: the old random token keeps working as the bearer
      // value until the user regenerates this agent's identity.
      agents = [
        {
          id: randomUUID(),
          name: 'Agent 1',
          nsec: parsed.token,
          pubkey: null,
          npub: null,
          passwordEntryId: null,
          createdAt: now()
        }
      ]
      dirty = true
    } else {
      agents = []
      dirty = parsed.agents !== undefined
    }

    this.data = { enabled: parsed.enabled === true, agents }
    if (dirty) this.save()
    return this.data
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp`
    writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(temp, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Best effort where POSIX modes do not exist.
    }
  }
}

function freshIdentity(): { nsec: string; pubkey: string; npub: string } {
  const secret = generateSecretKey()
  return { nsec: nsecOf(secret), pubkey: hexPubkeyOf(secret), npub: npubOf(secret) }
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

function isAgentRecord(value: unknown): value is AgentRecord {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AgentRecord>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.nsec === 'string' &&
    (candidate.pubkey === null || typeof candidate.pubkey === 'string') &&
    (candidate.npub === null || typeof candidate.npub === 'string') &&
    (candidate.passwordEntryId === null || typeof candidate.passwordEntryId === 'string') &&
    typeof candidate.createdAt === 'number'
  )
}
