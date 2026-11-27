import {
  DEFAULT_HOSTED_TTL_SECONDS,
  type HostingState,
  type HostingVisibility
} from '@shared/hosting'
import type { EndpointConfidence, EndpointKind } from '@shared/reachability'
import type { IdentityStatus } from '@shared/types'
import type { PrefillDraft } from './serviceDraft'

export interface HostingSettingsProps {
  identity: IdentityStatus | null
  initialDraft?: PrefillDraft | null
  onDraftUsed?: () => void
  onOpenIdentity: () => void
  onIdentityChange?: (status: IdentityStatus) => void
  onClose: () => void
}

export interface DraftState {
  id?: string
  title: string
  service: string
  endpoints: string
  /** TLS pins from an existing service, keyed by endpoint URL. */
  pins: Record<string, string>
  ttlDays: string
  visibility: HostingVisibility
  anchor: boolean
  notes: string
}

export const EMPTY_DRAFT: DraftState = {
  title: '',
  service: '',
  endpoints: '',
  pins: {},
  ttlDays: String(DEFAULT_HOSTED_TTL_SECONDS / 86_400),
  visibility: 'private',
  anchor: true,
  notes: ''
}

export const ENDPOINT_KIND_LABEL: Record<EndpointKind, string> = {
  loopback: 'This machine',
  lan: 'Local network',
  ipv6: 'IPv6',
  'public-v4': 'Public IPv4',
  onion: 'Tor onion',
  'current-https': 'Current page'
}

export const ENDPOINT_CONFIDENCE_LABEL: Record<EndpointConfidence, string> = {
  'owner-only': 'owner only',
  'same-network': 'same network',
  'firewall-dependent': 'firewall-dependent',
  mapped: 'mapped',
  verified: 'verified',
  unverified: 'unverified'
}

export type ExternalChecks = 'ask' | 'always' | 'never'

export interface DiscoverOptions {
  external?: boolean
  port?: number
  secure?: boolean
}

export type DiscoverFn = (seed: string, options?: DiscoverOptions) => void

export interface ShareResult {
  recipient: string
  address: string
}

export interface ShareFailure {
  recipient: string
  error: string
}

/** State and helpers shared by every hosting action. */
export interface HostingFeedback {
  busy: boolean
  setBusy: (value: boolean) => void
  error: string | null
  setError: (value: string | null) => void
  apply: (next: HostingState) => void
  copied: string | null
  copy: (id: string, text: string) => Promise<void>
}
