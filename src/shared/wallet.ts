export type WalletCurrency = 'BTC' | 'XMR'

export interface MoneroWalletRecord {
  version: 1
  seed: string
  address: string
  restoreHeight: number
  backupConfirmed: true
  syncChoice: 'local' | 'encrypted-relay'
}

export interface WalletStatus {
  identityReady: boolean
  bitcoinAvailable: boolean
  moneroConfigured: boolean
  moneroSyncChoice: 'local' | 'encrypted-relay' | null
  bitcoinAddress: string | null
  moneroAddress: string | null
  error: string | null
}

export interface WalletBalance {
  currency: WalletCurrency
  total: string
  available: string
  pending: string
  updatedAt: number
}

export interface WalletTransaction {
  currency: WalletCurrency
  id: string
  direction: 'incoming' | 'outgoing' | 'unknown'
  amount: string
  fee: string | null
  confirmations: number
  timestamp: number | null
  status: 'confirmed' | 'pending' | 'failed'
}

export interface BitcoinSendPreview {
  token: string
  address: string
  amountSats: number
  feeSats: number
  totalSats: number
  expiresAt: number
}

export interface WalletSnapshot {
  status: WalletStatus
  balances: WalletBalance[]
  transactions: WalletTransaction[]
  receive: { currency: WalletCurrency; address: string }[]
}

export const DEFAULT_ESPLORA_URL = 'https://blockstream.info/api'
export const DEFAULT_MONERO_DAEMON_URL = 'https://xmr-node.cakewallet.com:18081'
