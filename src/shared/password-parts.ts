/**
 * Vaults stored as several encrypted events ("parts"). See
 * docs/password-vault-sharding.md. The rest of the app sees one merged vault.
 *
 * This build reads every part and keeps existing ones up to date. It never creates
 * one. `crates/ncc-vault/src/parts.rs` must agree; both run
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

function partVault(entries: PasswordEntry[]): PasswordVault {
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
