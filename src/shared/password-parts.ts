/**
 * Vaults stored as several encrypted events ("parts"). See
 * docs/password-vault-sharding.md. The rest of the app sees one merged vault.
 *
 * `crates/ncc-vault/src/parts.rs` must agree; both run
 * `test/fixtures/password-parts-vectors.json`.
 */
import {
  MAX_VAULT_BYTES,
  PASSWORD_VAULT_D,
  PASSWORD_VAULT_VERSION,
  isVaultChangeAllowed,
  vaultByteLength,
  type PasswordEntry,
  type PasswordVault
} from './passwords'

export const MAX_VAULT_PARTS = 16
/** New entries prefer a part with this much room left to grow. */
export const VAULT_PART_TARGET_BYTES = 32_000
export const VAULT_INCOMPLETE = 'Some passwords haven’t synced yet'

/** Which entry ids each loaded part holds. A part that is not loaded has no key. */
export type VaultLayout = Map<number, Set<string>>

export function vaultPartD(index: number): string {
  return index === 0 ? PASSWORD_VAULT_D : `${PASSWORD_VAULT_D}/${index}`
}

export const VAULT_PART_DS = Array.from({ length: MAX_VAULT_PARTS }, (_, index) => vaultPartD(index))

/** The part a signed vault event holds, or null when it is not a vault part. */
export function vaultPartIndex(tags: string[][]): number | null {
  const d = tags.find((tag) => tag[0] === 'd')?.[1]
  const index = d === undefined ? -1 : VAULT_PART_DS.indexOf(d)
  return index < 0 ? null : index
}

/** How many parts the writer of a decrypted payload knew about. */
export function declaredParts(payload: unknown): number {
  const parts = payload && typeof payload === 'object' ? (payload as { parts?: unknown }).parts : 0
  return typeof parts === 'number' && Number.isInteger(parts) && parts > 0
    ? Math.min(parts, MAX_VAULT_PARTS)
    : 0
}

/** True when a part that is known to exist has not been loaded. */
export function isVaultIncomplete(layout: VaultLayout, declared: number): boolean {
  const count = Math.max(declared, ...[...layout.keys()].map((index) => index + 1))
  for (let index = 0; index < count; index += 1) {
    if (!layout.has(index)) return layout.size > 0
  }
  return false
}

/**
 * Divide the merged vault between the loaded parts. An entry stays in every part that
 * already holds it, so no copy keeps an old password. A new entry joins one loaded
 * part. An entry the vault lacks is left out here but stays in the layout.
 */
export function splitVault(vault: PasswordVault, layout: VaultLayout): Map<number, PasswordVault> {
  const indexes = [...layout.keys()].sort((a, b) => a - b)
  // With nothing loaded and nothing known, this is a new vault.
  if (indexes.length === 0) indexes.push(0)

  const held = new Map<number, PasswordEntry[]>(indexes.map((index) => [index, []]))
  const fresh: PasswordEntry[] = []
  for (const entry of vault.entries) {
    const homes = indexes.filter((index) => layout.get(index)?.has(entry.id))
    if (homes.length === 0) fresh.push(entry)
    else for (const index of homes) held.get(index)!.push(entry)
  }

  const size = (index: number, extra: PasswordEntry): number =>
    vaultByteLength(partVault([...held.get(index)!, extra]))
  for (const entry of fresh.sort(byAge)) {
    const index =
      indexes.find((candidate) => size(candidate, entry) <= VAULT_PART_TARGET_BYTES) ??
      indexes.find((candidate) => size(candidate, entry) <= MAX_VAULT_BYTES) ??
      indexes[0]
    held.get(index)!.push(entry)
  }

  return new Map(indexes.map((index) => [index, partVault(held.get(index)!)]))
}

export interface VaultPlan {
  /** The layout with new homes added. Nothing saved is removed from it. */
  layout: VaultLayout
  /** What each part should hold, with every home filled. */
  parts: Map<number, PasswordVault>
  /**
   * Entries that must leave a part to keep it within the limit. Each may be removed
   * only once another of its homes is confirmed saved.
   */
  leaving: Map<number, Set<string>>
  /** True when some part cannot be brought within the limit. */
  full: boolean
}

/**
 * Place the vault, adding parts and second homes where the size limit needs them.
 * `saved` is the last known copy of each part: only growth beyond it is limited.
 * `nextPart` is the index a new part would take, or null when none may be created.
 */
export function planVault(
  vault: PasswordVault,
  layout: VaultLayout,
  saved: Map<number, PasswordVault>,
  nextPart: number | null
): VaultPlan {
  const homes: VaultLayout = new Map([...layout].map(([index, ids]) => [index, new Set(ids)]))
  // With nothing loaded and nothing known, this is a new vault.
  if (homes.size === 0) homes.set(0, new Set())
  let upcoming = nextPart === null ? MAX_VAULT_PARTS : Math.max(nextPart, ...[...homes.keys()].map((i) => i + 1))

  const held = new Map<number, Map<string, PasswordEntry>>(
    [...homes.keys()].map((index) => [index, new Map()])
  )
  const fresh: PasswordEntry[] = []
  for (const entry of vault.entries) {
    let placed = false
    for (const [index, ids] of homes) {
      if (!ids.has(entry.id)) continue
      held.get(index)!.set(entry.id, entry)
      placed = true
    }
    if (!placed) fresh.push(entry)
  }

  const sizeOf = (entries: Iterable<PasswordEntry>): number => vaultByteLength(partVault([...entries]))
  const put = (index: number, entry: PasswordEntry): void => {
    homes.get(index)!.add(entry.id)
    held.get(index)!.set(entry.id, entry)
  }
  /** A part with room for the entry, creating one if allowed. */
  const roomFor = (entry: PasswordEntry, not: number | null): number | null => {
    const sizes = [...held]
      .filter(([index]) => index !== not)
      .sort(([a], [b]) => a - b)
      .map(([index, entries]) => ({ index, size: sizeOf([...entries.values(), entry]) }))
    const found =
      sizes.find(({ size }) => size <= VAULT_PART_TARGET_BYTES) ??
      sizes.find(({ size }) => size <= MAX_VAULT_BYTES)
    if (found) return found.index
    if (upcoming >= MAX_VAULT_PARTS || sizeOf([entry]) > MAX_VAULT_BYTES) return null
    const index = upcoming++
    homes.set(index, new Set())
    held.set(index, new Map())
    return index
  }

  for (const entry of fresh.sort(byAge)) {
    put(roomFor(entry, null) ?? Math.min(...held.keys()), entry)
  }

  const leaving = new Map<number, Set<string>>()
  let full = false
  for (const index of [...held.keys()].sort((a, b) => a - b)) {
    const entries = held.get(index)!
    const before = saved.get(index) ?? null
    const staying = new Map(entries)
    const fits = (): boolean => isPartChangeAllowed(before, partVault([...staying.values()]))
    if (fits()) continue

    const old = new Map((before?.entries ?? []).map((entry) => [entry.id, entry]))
    const growth = (entry: PasswordEntry): number => {
      const previous = old.get(entry.id)
      return sizeOf([entry]) - (previous ? sizeOf([previous]) : 0)
    }
    // Entries this part has never saved go first: they can move without waiting.
    const growers = [...entries.values()]
      .filter((entry) => !old.has(entry.id) || growth(entry) > 0)
      .sort(
        (a, b) =>
          Number(old.has(a.id)) - Number(old.has(b.id)) ||
          growth(b) - growth(a) ||
          a.id.localeCompare(b.id)
      )
    for (const entry of growers) {
      if (fits()) break
      const elsewhere = [...homes].some(([other, ids]) => other !== index && ids.has(entry.id))
      if (!elsewhere) {
        const target = roomFor(entry, index)
        if (target === null) continue
        put(target, entry)
      }
      staying.delete(entry.id)
      if (old.has(entry.id)) {
        let moving = leaving.get(index)
        if (!moving) leaving.set(index, (moving = new Set()))
        moving.add(entry.id)
      } else {
        homes.get(index)!.delete(entry.id)
        entries.delete(entry.id)
      }
    }
    full ||= !fits()
  }

  return {
    layout: homes,
    parts: new Map(
      [...held]
        .sort(([a], [b]) => a - b)
        .map(([index, entries]) => [index, partVault([...entries.values()])])
    ),
    leaving,
    full
  }
}

/** The payload that is encrypted. A single-part vault is exactly the old format. */
export function partPayload(part: PasswordVault, count: number): PasswordVault & { parts?: number } {
  return count > 1 ? { ...part, parts: count } : part
}

/** The size limit applies to each part, not to the vault as a whole. */
export function isPartChangeAllowed(before: PasswordVault | null, after: PasswordVault): boolean {
  return isVaultChangeAllowed(before ?? partVault([]), after)
}

function byAge(a: PasswordEntry, b: PasswordEntry): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
}

export function partVault(entries: PasswordEntry[]): PasswordVault {
  const sorted = [...entries].sort(byAge).map((entry) => {
    // Written only when true, so both platforms measure the same size.
    if (entry.favorite !== false) return entry
    const { favorite: _unset, ...rest } = entry
    return rest
  })
  return {
    v: PASSWORD_VAULT_VERSION,
    updatedAt: sorted.reduce((max, entry) => Math.max(max, entry.updatedAt), 0),
    entries: sorted
  }
}
