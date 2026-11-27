/** What the chrome knows about sync. No decrypted browsing data other than other devices' tabs. */

export interface SyncCategories {
  bookmarks: boolean
  tabs: boolean
  history: boolean
  identities: boolean
}

export type SyncCategory = keyof SyncCategories

export interface SyncDeviceTab {
  url: string
  title: string
}

export interface SyncDevice {
  id: string
  name: string
  platform: string
  /** Epoch milliseconds the device last published its tabs. */
  updatedAt: number
  tabs: SyncDeviceTab[]
}

export interface SyncStatus {
  /** A signing identity is available; sync is encrypted to it. */
  identity: boolean
  categories: SyncCategories
  deviceId: string
  deviceName: string
  syncing: boolean
  /** Epoch milliseconds of the last complete sync, or null. */
  lastSyncedAt: number | null
  error: string | null
  /** Other devices that publish their tabs. */
  devices: SyncDevice[]
  /** Previous default-key owner, when an identity vault migration needs confirmation. */
  identityMigrationFrom?: string
  /** That previous identity is no longer on this device, so the list cannot be migrated. */
  identityOwnerMissing?: boolean
  /** The key the synced list is encrypted to. It cannot be removed while identity sync is on. */
  identityOwner?: string
  /** Keys on this device that have been removed from identity sync. */
  identityRemovals?: IdentityRemoval[]
  /** Goes up whenever sync adds a key here, so open identity lists can reload. */
  identityRevision?: number
}

export interface IdentityRemoval {
  pubkey: string
  npub: string
  /** The person chose to keep this key here. */
  kept: boolean
}

/** What removing a saved key means for identity sync. */
export type IdentityRemovalScope = 'device' | 'everywhere'

export interface SyncPrefsPatch {
  categories?: Partial<SyncCategories>
  deviceName?: string
}
