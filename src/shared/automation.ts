/** One agent connected to the agent-control server, as shown in Settings → Agent control. */
export interface AgentSummary {
  id: string
  name: string
  /** Null only for an agent migrated from before per-agent Nostr identities existed. */
  npub: string | null
  /** The vault entry holding this agent's nsec, if one has been stored. */
  passwordEntryId: string | null
  /** Sites this agent may currently act on without asking. */
  grants: string[]
  /** Sites this agent may sign in to via NIP-07, as its own identity, without asking. */
  signGrants: string[]
  /** The connect command with the nsec masked; null while the server isn't running. */
  maskedCommand: string | null
}

/** State of the agent-control server, as shown in Settings → Agent control. */
export interface AutomationState {
  enabled: boolean
  /** True when the environment forces it on (`NCC_AUTOMATION=1`). */
  forced: boolean
  running: boolean
  url: string | null
  agents: AgentSummary[]
  error: string | null
}
