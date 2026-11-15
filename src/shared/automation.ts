/** State of the agent-control server, as shown in Settings → Agent control. */
export interface AutomationState {
  enabled: boolean
  /** True when the environment forces it on (`NCC_AUTOMATION=1`). */
  forced: boolean
  running: boolean
  url: string | null
  /** Last characters of the access token, so the user can tell tokens apart. */
  tokenHint: string
  /** Sites the agent may currently act on without asking. */
  grants: string[]
  error: string | null
}
