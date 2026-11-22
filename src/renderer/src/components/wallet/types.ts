import type { NwcSnapshot, WalletSnapshot } from '@shared/wallet'

export interface WalletPanelProps {
  onClose: () => void
  onOpenIdentitySettings: () => void
}

export interface WalletSettings {
  esploraUrl: string
  privacyNotice: string
}

/**
 * The wallet's shared data and feedback. Views own their dialogs and local form
 * state, but snapshot, settings, NWC status and the status line are common to all
 * three currencies, so they stay in one place.
 */
export interface WalletContext {
  snapshot: WalletSnapshot | null
  settings: WalletSettings | null
  nwc: NwcSnapshot | null
  setNwc: (value: NwcSnapshot) => void
  busy: boolean
  setBusy: (value: boolean) => void
  message: string
  setMessage: (value: string) => void
  refresh: () => Promise<void>
  copy: (value: string) => Promise<void>
  saveSettings: (esploraUrl: string) => Promise<boolean>
  onOpenIdentitySettings: () => void
}

export function shortId(id: string): string {
  return `${id.slice(0, 12)}…${id.slice(-8)}`
}
