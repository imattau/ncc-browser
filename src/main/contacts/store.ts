import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ContactProfile } from '@shared/contacts'

export interface StoredContacts {
  contacts: ContactProfile[]
  contactsFetchedAt: number
  profilesFetchedAt: number
  eventCreatedAt?: number
}

interface ContactsFile {
  version: 1
  owners: Record<string, StoredContacts>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowMs(): number {
  return Date.now()
}

/**
 * Cached kind-3 follow lists and kind-0 labels, keyed by owner hex. The cache exists
 * for instant opening of the share picker; a refresh is a normal relay query.
 */
export class ContactsStore {
  private cache: ContactsFile | null = null

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = nowMs
  ) {}

  get(owner: string): StoredContacts | null {
    return clone(this.ensure().owners[owner.toLowerCase()] ?? null)
  }

  put(owner: string, record: StoredContacts): StoredContacts {
    const key = owner.toLowerCase()
    this.ensure().owners[key] = record
    this.flush()
    return clone(record)
  }

  mergeProfiles(owner: string, profiles: ContactProfile[], fetchedAt = this.now()): StoredContacts {
    const key = owner.toLowerCase()
    const existing = this.ensure().owners[key] ?? {
      contacts: [],
      contactsFetchedAt: 0,
      profilesFetchedAt: 0
    }
    const byPubkey = new Map(existing.contacts.map((contact) => [contact.pubkey, contact]))
    for (const profile of profiles) {
      const previous = byPubkey.get(profile.pubkey)
      byPubkey.set(profile.pubkey, {
        ...previous,
        ...profile,
        ...(profile.name ? { name: profile.name } : {}),
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.picture ? { picture: profile.picture } : {}),
        ...(profile.nip05 ? { nip05: profile.nip05 } : {})
      })
    }
    const record: StoredContacts = {
      ...existing,
      contacts: [...byPubkey.values()],
      profilesFetchedAt: fetchedAt
    }
    this.ensure().owners[key] = record
    this.flush()
    return clone(record)
  }

  clear(owner: string): void {
    delete this.ensure().owners[owner.toLowerCase()]
    this.flush()
  }

  private ensure(): ContactsFile {
    this.cache ??= this.read()
    return this.cache
  }

  private read(): ContactsFile {
    if (!existsSync(this.filePath)) return { version: 1, owners: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ContactsFile>
      if (!parsed || parsed.version !== 1) return { version: 1, owners: {} }
      return normalizeFile(parsed)
    } catch (error) {
      console.warn('[contacts] ignoring unreadable contacts cache:', error)
      return { version: 1, owners: {} }
    }
  }

  private flush(): void {
    const file = this.ensure()
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporary, this.filePath)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Some filesystems do not implement POSIX modes.
    }
  }
}

function normalizeFile(parsed: Partial<ContactsFile>): ContactsFile {
  const owners: Record<string, StoredContacts> = {}
  for (const [owner, raw] of Object.entries(parsed.owners ?? {})) {
    if (!/^[0-9a-f]{64}$/i.test(owner) || !raw || typeof raw !== 'object') continue
    const contacts: ContactProfile[] = []
    const seen = new Set<string>()
    for (const contact of Array.isArray(raw.contacts) ? raw.contacts : []) {
      if (!contact || typeof contact.pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(contact.pubkey)) {
        continue
      }
      const pubkey = contact.pubkey.toLowerCase()
      if (seen.has(pubkey)) continue
      seen.add(pubkey)
      contacts.push({
        pubkey,
        ...(typeof contact.name === 'string' ? { name: contact.name.slice(0, 80) } : {}),
        ...(typeof contact.displayName === 'string'
          ? { displayName: contact.displayName.slice(0, 80) }
          : {}),
        ...(typeof contact.picture === 'string' ? { picture: contact.picture } : {}),
        ...(typeof contact.nip05 === 'string' ? { nip05: contact.nip05.slice(0, 120) } : {})
      })
    }
    owners[owner.toLowerCase()] = {
      contacts: contacts.slice(0, 2000),
      contactsFetchedAt: Number.isFinite(raw.contactsFetchedAt) ? raw.contactsFetchedAt : 0,
      profilesFetchedAt: Number.isFinite(raw.profilesFetchedAt) ? raw.profilesFetchedAt : 0,
      ...(Number.isFinite(raw.eventCreatedAt) ? { eventCreatedAt: raw.eventCreatedAt } : {})
    }
  }
  return { version: 1, owners }
}
