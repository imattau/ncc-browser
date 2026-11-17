/** What the chrome knows about sync. No decrypted browsing data other than other devices' tabs. */

export interface SyncCategories {
  bookmarks: boolean
  tabs: boolean
  history: boolean
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
}

export interface SyncPrefsPatch {
  categories?: Partial<SyncCategories>
  deviceName?: string
}
