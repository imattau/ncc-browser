/**
 * Identity, NIP-46 remote signer and the NIP-07 approval flow.
 */

export type IdentitySource = 'none' | 'env' | 'file' | 'session'

export type IdentityMode = 'none' | 'local' | 'nip46'

export interface IdentityStatus {
  configured: boolean
  mode: IdentityMode
  npub?: string
  hexPubkey?: string
  source: IdentitySource
  /** True when the key (or NIP-46 session) is encrypted at rest with the OS keychain. */
  persisted: boolean
  /** False when the OS offers no secure storage; the key then lives for this session. */
  encryptionAvailable: boolean
  /** NIP-46 relays, when mode is `nip46`. */
  relays?: string[]
  /** NIP-46 connection acknowledged by the remote signer. */
  connected?: boolean
}

export interface IdentityProfile {
  id: string
  mode: 'local' | 'nip46'
  npub?: string
  hexPubkey: string
  active: boolean
  isDefault: boolean
  persisted: boolean
  connected?: boolean
}

export interface IdentityList {
  identities: IdentityProfile[]
  activeId: string | null
  defaultId: string | null
}

export interface SignerPermission {
  /** `ncc://<npub>` or a web origin. */
  origin: string
  label: string
  trusted: boolean
  /** Epoch milliseconds. */
  createdAt: number
  lastUsedAt: number
}

/** Trust state for the page the site panel is showing. */
export interface SignerOriginState {
  origin: string
  label: string
  trusted: boolean
}

export interface SignerRequest {
  id: string
  method: string
  /** Short imperative phrase, e.g. "sign a kind 1 event". */
  action: string
  /** `ncc://<npub>/<service>` or a web origin. */
  service: string
  origin: string
  identity: string | null
  mode: IdentityMode
  /** Present for `signEvent`. */
  event?: {
    kind: number
    created_at: number
    tags: string[][]
    content: string
  }
  /** Extra context for encryption/decryption requests. */
  note?: string
  rememberable: boolean
  /** Private or Tor tab: permissions last for this session only. */
  ephemeral?: boolean
  /** Tor tab: remote-signer relay traffic is not routed through Tor. */
  torTab?: boolean
  /** Label for the remember control, e.g. "Always allow" or "Remember for this session". */
  rememberLabel?: string
  /** Additional browser-owned approval flows shown in the same trusted prompt. */
  kind?: 'automation' | 'automation-signer' | 'payment-card-auth'
}

export interface SignerDecision {
  allow: boolean
  remember: boolean
}
