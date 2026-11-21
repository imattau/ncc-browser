/**
 * The signed-in identity's Nostr follow list (kind 3) and the profile metadata
 * (kind 0) used to label it. Shared by the contacts service, the IPC layer and the
 * share picker.
 */

export interface ContactProfile {
  /** Hex pubkey. */
  pubkey: string
  name?: string
  displayName?: string
  picture?: string
  nip05?: string
}

export interface ContactList {
  owner: string
  contacts: ContactProfile[]
  /** Unix ms of the last kind-3 fetch. */
  contactsFetchedAt: number
  /** Unix ms of the last kind-0 profile fetch. */
  profilesFetchedAt: number
  /** Created-at of the kind-3 event the list came from. */
  eventCreatedAt?: number
  /** True when the contacts are old enough that a refresh is due. */
  stale: boolean
}

export interface ContactsState {
  owner: string | null
  list: ContactList | null
  refreshing: boolean
  error?: string
}

export function contactLabel(contact: ContactProfile): string {
  return (
    contact.displayName?.trim() ||
    contact.name?.trim() ||
    contact.nip05?.trim() ||
    `${contact.pubkey.slice(0, 10)}…${contact.pubkey.slice(-6)}`
  )
}
