# Design: password vaults larger than one event

**Status:** implemented on desktop and Android. Stage 1 (read) shipped in 0.47.11.
Stage 2 (write) creates parts and moves entries between them.

## Problem

A vault used to be one NIP-44 encrypted event, limited to 40,000 bytes of plaintext so
that relays accept it. That is roughly 150 ordinary logins, and fewer with notes or passkeys.

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
- The first part records the count too, so a reader of only that part knows more exist.
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
4. **New parts** are added when no existing part has room, numbered after every part
   known to exist. The new part is published before the first part counts it. None is
   created while a known part is missing: it could be overwritten. The headroom between
   32,000 and 40,000 lets entries grow without moving.
5. **Moving** happens only when a change would grow a part past 40,000 bytes. An entry
   that part has never saved is simply placed elsewhere. A saved one moves in order:
   publish the destination, and remove it from the source only after every relay has
   accepted the destination. Until then the source keeps the copy it had. No extra
   state records a move: it is an entry with two homes in a part that is over the
   limit, so any later sync finishes it, also after a restart. If one configured relay
   never accepts writes, both copies remain, which merging by id makes harmless.
6. **Learning of a move.** When a newer copy of a part no longer has an entry and
   another part does, the entry is forgotten there. If no other part has it, another
   device overwrote it, and it is written back. A copy older than the one saved here
   never gives an entry back to a part it has left.

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
  missing. A version before 0.47.11 cannot import this format.
- Import accepts both. CSV is unchanged.
- An import is placed across parts, creating them as needed.

## Older versions

A device on a version before 0.47.11 reads and writes only the first part. It does not
damage the others, but it does not show their entries and cannot delete them.

0.47.11 reads and updates all parts, but does not learn of moves: it can write a moved
entry back into the part it left, leaving two copies and possibly a first part over
40,000 bytes. Nothing is lost, but a relay may reject a part that grows much further.

Update every device before the vault outgrows one part.

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
- Several devices with offline edits and refused publishes converge on the expected
  logins, then stop publishing. Both platforms run this with random operations; set
  `NCC_VAULT_SEEDS` for a longer Rust run.
