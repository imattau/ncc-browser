# Design: password vaults larger than one event

**Status:** stage 1 (read) is implemented on desktop and Android. Stage 2 (write) is
not: no build creates a second part yet, so the 40,000-byte limit still applies.

## Problem

The vault is one NIP-44 encrypted event, limited to 40,000 bytes of plaintext so that
relays accept it. That is roughly 150 ordinary logins, and fewer with notes or passkeys.

## What the user sees

One password list, as now. There is nothing to create, name, choose or maintain: the
browser adds another encrypted part when it needs one. Parts are never mentioned in the
UI. The only new message is shown when a part could not be fetched:
**"Some passwords haven't synced yet"**.

## Format

| Part | `d` tag |
| --- | --- |
| First | `ncc-browser/passwords/v1` (today's event, unchanged) |
| Next | `ncc-browser/passwords/v1/1`, `/2`, … |

- Every part has today's payload (`{ v, updatedAt, entries }`) plus `parts`, the number
  of parts the writer knew about. A reader that has fewer knows its copy is incomplete.
- Query by author, kind and the 16 possible `d` tags, and accept nothing else. No
  separate index event is needed, so no index can disagree with the parts.
- Existing vaults need no migration. They are a vault with one part.
- Limit: 16 parts. Relays can see how many exist, their approximate sizes and which one
  changed. They cannot see the contents.

## Reading

Decrypt every part and combine them with the existing `mergeVaults` rule (by entry id,
newest wins). The rest of the app keeps working with one in-memory `PasswordVault`.

**A missing part is never a deletion.** Only a tombstone deletes. A relay that returns
some parts, or an old copy of one, must not remove anything from this device.

## Writing

1. **Entries stay where they are.** An edit or delete rewrites only the parts that hold
   the entry. Most saves publish one event, as now.
2. **Every copy is kept up to date.** If two devices placed the same entry in different
   parts, each part gets the winning version, so no part keeps an old password or the
   secrets of a deleted login.
3. **New entries** go in the first loaded part that stays below 32,000 bytes, then the
   first that stays below 40,000. A part that has not been fetched is never written.
4. **New parts** (stage 2) are added when no existing part has room. The headroom
   between 32,000 and 40,000 lets entries grow without moving.
5. **Moving** (stage 2) happens only when an edit would push a part over 40,000 bytes.
   Publish the destination first. Remove the entry from the source only after every
   relay that will receive that change has accepted the destination. A failure leaves a
   duplicate, which merging by id makes harmless. Stage 1 refuses such an edit.

Each part has its own `created_at` watermark and pending flag, so a failed publish
retries only that part. Two devices adding at once can both write the same part; as
today, the device whose entry was replaced still has it locally and publishes it again
at its next sync.

## Local storage

The cache keeps one ciphertext event for each part. The first stays where it always was
(`vaults.<pubkey>`); later ones are in `parts.<pubkey>.<index>`. An older build reads
the same file unchanged. Unlock opens all cached parts before any network request.

## Import and export

- A vault with one part exports as before. With more, encrypted export writes
  `{ format: "ncc-password-vault", events: [...] }`, and refuses while a part is
  missing.
- Import accepts both. CSV is unchanged.
- An import is placed across the existing parts. A backup larger than they can hold
  cannot be restored until stage 2 can create parts.

## Older versions

An older build reads and writes only the first part. It does not damage the others, but
it will not show their entries, and a delete made there for an entry held in another
part is impossible. Release in two steps:

1. **Read (done):** desktop and Android read and merge all parts, and keep existing ones
   up to date. They do not create new parts.
2. **Write:** a later release creates parts. Its release notes ask users to update every
   device.

A mixed setup can leave copies of one entry in the first part and a later one. Merging
by id covers it.

## Where the code is

| Area | Files |
| --- | --- |
| Part tags and placement | `src/shared/password-parts.ts`, `crates/ncc-vault/src/parts.rs` |
| Fetch, merge and publish | `src/main/passwords/sync.ts`, `crates/ncc-proxy/src/vault.rs` |
| Cache | `src/main/passwords/cache.ts`, `crates/ncc-vault/src/cache.rs` |
| Export and import (desktop) | `src/main/passwords/transfer.ts`, `vault-ops.ts` |

Both platforms must measure the same JSON size.
`test/fixtures/password-parts-vectors.json` checks placement and size on each.

## Tests that matter

- A partial relay answer removes nothing.
- A failed or partial publish during a move loses nothing.
- Two devices saving at once converge.
- A single-part vault and its cache open unchanged.
- An older build writing the first part cannot hide or delete entries in other parts.
- Desktop and Android produce the same placement from the same vault.
