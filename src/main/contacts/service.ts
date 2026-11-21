import { verifyEvent, type Event } from 'nostr-tools'
import type { ContactList, ContactProfile, ContactsState } from '@shared/contacts'
import type { RelayPool } from '../relay/pool'
import type { ConfigStore } from '../config'
import { discoverWriteRelays } from '../relay/nip65'
import type { ContactsStore, StoredContacts } from './store'

const CONTACTS_TTL_MS = 6 * 60 * 60_000
const PROFILES_TTL_MS = 7 * 24 * 60 * 60_000
const MAX_RELAYS = 12
const PROFILE_BATCH = 100

export interface ContactsServiceDeps {
  store: ContactsStore
  relays: Pick<RelayPool, 'query'>
  config: ConfigStore
  owner: () => string | null
  now?: () => number
  onChange?: (state: ContactsState) => void
}

/**
 * The active identity's kind-3 follow list, with kind-0 names cached for the picker.
 *
 * `state()` returns the cache immediately and starts a background refresh when it is
 * older than six hours. `refresh()` is the explicit path used by the Refresh button.
 */
export class ContactsService {
  private readonly now: () => number
  private readonly refreshing = new Map<string, Promise<ContactList | null>>()
  private readonly errors = new Map<string, string>()

  constructor(private readonly deps: ContactsServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  state(): ContactsState {
    return this.buildState(true)
  }

  private buildState(autoRefresh: boolean): ContactsState {
    const owner = this.deps.owner()?.toLowerCase() ?? null
    if (!owner) return { owner: null, list: null, refreshing: false }
    const cached = this.deps.store.get(owner)
    const list = cached ? toList(owner, cached, this.now()) : null
    if (autoRefresh && (!cached || this.isStale(cached)) && !this.refreshing.has(owner)) {
      void this.refresh(owner).catch(() => undefined)
    }
    return {
      owner,
      list,
      refreshing: this.refreshing.has(owner),
      ...(this.errors.get(owner) ? { error: this.errors.get(owner) } : {})
    }
  }

  async refresh(ownerInput?: string | null): Promise<ContactList | null> {
    const owner = (ownerInput ?? this.deps.owner())?.toLowerCase() ?? null
    if (!owner) return null
    const running = this.refreshing.get(owner)
    if (running) return running

    const promise = this.fetch(owner)
      .then((list) => {
        this.errors.delete(owner)
        this.changed()
        return list
      })
      .catch((error) => {
        this.errors.set(owner, messageOf(error))
        this.changed()
        throw error
      })
      .finally(() => {
        this.refreshing.delete(owner)
        this.changed()
      })
    this.refreshing.set(owner, promise)
    this.changed()
    return promise
  }

  forget(owner: string): void {
    this.deps.store.clear(owner)
    this.errors.delete(owner.toLowerCase())
    this.changed()
  }

  private async fetch(owner: string): Promise<ContactList | null> {
    const relays = await this.relaysFor(owner)
    if (relays.length === 0) throw new Error('No relays are configured')

    const events = await this.deps.relays.query(relays, {
      kinds: [3],
      authors: [owner],
      limit: 1
    })
    const latest = events
      .filter((event) => event.kind === 3 && event.pubkey === owner && verifyEvent(event))
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
    if (!latest) {
      // Keep an existing cache rather than wiping it on a relay hiccup; a fresh
      // install with no kind-3 simply has no contacts.
      const cached = this.deps.store.get(owner)
      return cached ? toList(owner, cached, this.now()) : null
    }

    const pubkeys = [
      ...new Set(
        latest.tags
          .filter((tag) => tag[0] === 'p' && /^[0-9a-f]{64}$/i.test(tag[1] ?? ''))
          .map((tag) => tag[1].toLowerCase())
      )
    ].slice(0, 2000)

    const cached = this.deps.store.get(owner)
    const existing = new Map((cached?.contacts ?? []).map((contact) => [contact.pubkey, contact]))
    const needsProfiles =
      !cached ||
      this.now() - cached.profilesFetchedAt > PROFILES_TTL_MS ||
      pubkeys.some((pubkey) => !existing.has(pubkey))

    let profiles: ContactProfile[] = pubkeys.map((pubkey) => existing.get(pubkey) ?? { pubkey })
    if (needsProfiles) {
      const fetched = new Map<string, ContactProfile>()
      for (let offset = 0; offset < pubkeys.length; offset += PROFILE_BATCH) {
        const batch = pubkeys.slice(offset, offset + PROFILE_BATCH)
        try {
          const profileEvents = await this.deps.relays.query(relays, {
            kinds: [0],
            authors: batch,
            limit: batch.length
          })
          for (const event of profileEvents) {
            if (event.kind !== 0 || !verifyEvent(event) || !batch.includes(event.pubkey)) continue
            const profile = parseProfile(event)
            if (profile) fetched.set(event.pubkey, profile)
          }
        } catch {
          // Keep whatever labels were cached; a profile miss must not fail contacts.
        }
      }
      profiles = profiles.map((profile) => {
        const fresh = fetched.get(profile.pubkey)
        return fresh ? { ...profile, ...fresh } : profile
      })
    }

    const record: StoredContacts = {
      contacts: profiles,
      contactsFetchedAt: this.now(),
      profilesFetchedAt: needsProfiles ? this.now() : (cached?.profilesFetchedAt ?? 0),
      eventCreatedAt: latest.created_at
    }
    this.deps.store.put(owner, record)
    return toList(owner, record, this.now())
  }

  private async relaysFor(owner: string): Promise<string[]> {
    const configured = this.deps.config.getRelays()
    try {
      const write = await discoverWriteRelays(this.deps.relays.query, owner, configured)
      return [...new Set([...configured, ...write])].slice(0, MAX_RELAYS)
    } catch {
      return configured.slice(0, MAX_RELAYS)
    }
  }

  private isStale(record: StoredContacts): boolean {
    return this.now() - record.contactsFetchedAt > CONTACTS_TTL_MS
  }

  private changed(): void {
    this.deps.onChange?.(this.buildState(false))
  }
}

function toList(owner: string, record: StoredContacts, now: number): ContactList {
  return {
    owner,
    contacts: record.contacts,
    contactsFetchedAt: record.contactsFetchedAt,
    profilesFetchedAt: record.profilesFetchedAt,
    ...(record.eventCreatedAt ? { eventCreatedAt: record.eventCreatedAt } : {}),
    stale: now - record.contactsFetchedAt > CONTACTS_TTL_MS
  }
}

function parseProfile(event: Event): ContactProfile | null {
  try {
    const parsed = JSON.parse(event.content) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      pubkey: event.pubkey.toLowerCase(),
      ...(typeof parsed.name === 'string' && parsed.name.trim()
        ? { name: parsed.name.trim().slice(0, 80) }
        : {}),
      ...(typeof parsed.display_name === 'string' && parsed.display_name.trim()
        ? { displayName: parsed.display_name.trim().slice(0, 80) }
        : {}),
      ...(typeof parsed.picture === 'string' && /^https?:\/\//i.test(parsed.picture)
        ? { picture: parsed.picture.slice(0, 2048) }
        : {}),
      ...(typeof parsed.nip05 === 'string' && parsed.nip05.trim()
        ? { nip05: parsed.nip05.trim().slice(0, 120) }
        : {})
    }
  } catch {
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
