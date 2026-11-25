# Separate keys for private services — design

**Status:** draft for review; nothing here is implemented. Proposed for v0.48.0.

## Problem

Private services and shares are signed by the publisher's personal key. The endpoints are
encrypted, but anyone reading the relays can see that this identity runs a service, its
service id, and when its records change. v0.47.7 removes some leaks (fingerprints in
new readable records, guessable share ids) but not this one.

## Goal and non-goals

Goal: readable relay records for a private service should not, by their keys, ids or
contents, connect it to the publisher's personal identity, or connect one share to
another.

Not goals:

- Access control. Anyone who reaches an endpoint can use the service. A recipient can
  pass the endpoints on. A service that needs a login still needs one.
- Hiding the publisher's IP from people who can open the link. Only an onion-only
  service does that.
- Hiding that someone published a locator, or its time, expiry and size.
- Undoing old records.

Public services do not change.

## Assumption

A private `ncc://` link is sent outside the public records, over a channel the recipient
already trusts. That channel says who the link is from.

So by default nothing in a record names the publisher: no identity proof, no personal
public key. The recipient gives the service a local name. If someone can alter the
channel, they can substitute their own link; this design does not detect that. An
optional identity proof can be added later for links that get forwarded.

## Keys and records

| Record | Signed by | Encrypted to | `d` tag |
| --- | --- | --- | --- |
| Main (owner's own access) | a random key for this service | the owner's personal key | random |
| One share | a random key for this share | the recipient's key | `share-<random>` |

- Keys are stable. A locator is replaceable by `pubkey + kind + d`, so renewing needs the
  same key and `d`.
- Renewing an active share keeps its key and link. Sharing again after revocation or
  expiry makes a new key and link.
- The service name the owner types becomes a local label. It never appears in a record.
- NIP-44 encryption uses the sender's secret and the recipient's public key. There is no
  `p` tag, so the record does not name the recipient. The desktop resolver already
  decrypts with the event author's public key, so this step should not need a change.
- Publishing and renewing sign and encrypt with the local per-record key, so they would
  not need the personal signer. That also allows automatic renewal for remote-signer
  (NIP-46) users, who renew by hand today. The recipient still needs their own signer to
  decrypt.

One consequence for recipients: a new link has a new origin, so cookies, site storage,
site permissions and saved passwords do not carry over after revoke and re-share.
Renewal keeps them.

## Links with relay hints

A new key has no NIP-65 relay list, so the link has to say where to look. `ncc://` has no
place for that today. A query string is not usable: the browser forwards it to the
service.

Proposal: accept a NIP-19 `nprofile` (public key plus relays) wherever the display form
accepts an `npub`:

```
ncc://nprofile1…/share-4f0c9a1b72de
```

- The internal origin form stays `ncc://<npub>.<service>/`, so origins do not depend on
  the hints.
- The browser stores hints per public key, so reload, history, bookmarks and session
  restore still work. Anything that copies or syncs an address must keep the `nprofile`.
- Hints are extra relays, never the only ones: configured relays are still queried.
  NCC-05 allows "additional relays as required".
- A link is untrusted input. Accept `wss://` only, at most three hints, and no loopback
  or private-network hosts. In a Tor tab, query them over Tor only.
- Following hints reveals the recipient's IP and the record they want to those relays. An
  unusual relay can also identify the people who use it. Default hints should be common
  relays, shown to the publisher before sharing.
- Older versions will reject an `nprofile` link. Check how the address bar, omnibox,
  password matching and extensions treat it.

## NCC-05 and NCC-02

Checked against `nostr-community-conventions` at `d9d285f`, plus the edit described below.

NCC-05 fits: records are signed by the resolved key, endpoints are encrypted, NIP-65 is
only a hint, and publishers should jitter refresh timing. NCC-05 says clients should
check an NCC-02 record first unless they are explicitly in unanchored mode.

So each key publishes an anchor for its own `d` tag, signed by that key, with `d` and
`exp` only. Under an unlinked random key it reveals little more than the locator does,
and recipients who require anchors keep working. This replaces the earlier suggestion to
leave anchors off.

**`k` in private records.** At `d9d285f`, NCC-02 listed `k` as required and did not say a
record without `u` could omit it, while v0.47.7 omits it. NCC-02 has since been edited to
allow this: the pin then comes from the encrypted locator. The edit is merged into
`master` as `8a3e068` (pull request #25); no new revision has been published to Nostr.
Clients built to the earlier text may still require `k`.

## Other ways records can be linked

| Link | Handling |
| --- | --- |
| Publish and renewal times | Give each record its own renewal time with random jitter. Do not renew everything in one pass. A first share must publish before its link is sent, so it cannot be delayed much. |
| IP address and relay connection | Offer publishing over Tor. Separate keys need separate circuits and connections; whether the current Tor relay pool can do that is unchecked. Without Tor, relays can link the records. |
| Looking up the publisher's NIP-65 list | Today's publisher queries it. Private records must use the hint relays and never copy or query the personal list. |
| Relay sign-in (NIP-42) | Never sign in with the personal key. Hosting publishing passes no sign-in handler today; a test should hold that. A relay that demands it is unusable here. |
| Endpoints and certificate | Not in readable records. Recipients who compare them can see two shares are the same service. Scanning can still find the server, but without a readable pin it has nothing to match. |
| Same size and expiry | Minor. Vary expiry by the renewal jitter. |
| Locator `notes` | Encrypted. Warn that recipients see it. |

## Storage, backup and other devices

Losing a record's key means losing the ability to update or revoke that link. It stays
usable until it expires.

- Use random keys. Deriving them from the personal key is not possible with a remote
  signer, and would expose them all if that key leaked.
- Keep secrets out of `services.json`, which promises to hold no key material. Protect
  them at least as well as a local identity.
- First version: an encrypted export file.
- Relay backup, if added later, must be opt-in. A backup under the personal key is
  visible as a record, and publishing it right after a new service links the two by time.
- Two devices publishing the same record can overwrite each other. State which device
  publishes.

## Data model and interface

- A hosted service keeps `owner` (the personal key allowed to manage it) and gains a
  publishing key reference. Each share gains its own key reference and relay hints.
- The service card shows whether a service uses a separate key.
- Publishers need a list of live links to renew or revoke.
- Recipients see an unknown key. Let them name a received share; keep that name local.
- Deleting a service must first retire every record: publish an expired locator and
  remove fingerprints from anchors. Only then delete the keys. If relays are unreachable,
  keep the keys and say so.

## Moving an existing service

1. Create new keys, a new random service id and a new certificate.
2. Publish and send new links.
3. Retire the old records and fingerprints under the personal key.

Retiring does not unlink anything: relays and others may keep copies, and the old name
stays attached to the personal identity. If that link matters, also move to a new
address or port, and reuse nothing readable. Do the retiring at a different time from
the new publishing.

## Android

From `crates/ncc-proxy/src/resolve.rs`, Android parses locator content as plain JSON
only. It appears unable to open any encrypted locator, so private links currently work
on desktop only. This was read from the code, not tested.

Android needs NIP-44 decryption (local and remote signer), `nprofile` parsing and relay
hints. Until then, the interface should not imply that a recipient on Android can open a
private link.

## Delivery

1. `nprofile` parsing, hint storage and hint-aware resolving on desktop.
2. Per-service and per-share keys, secret storage, export and import.
3. Publisher isolation: hint relays only, independent jittered renewal.
4. Retiring records on delete, and moving existing services.
5. Tor publishing with isolation.
6. Android decryption and hints.

Steps 1 and 2 ship together. Until step 3 is done, do not describe the records as
unlinked.

## Tests that must hold

- No event, relay query or relay sign-in made while publishing a private record contains
  or uses the personal public key.
- Two shares of one service have different authors and `d` tags, and no readable record
  contains a certificate fingerprint.
- The personal key can open the main record; only the intended recipient can open a
  share.
- Renewal keeps a link; revoke and re-share changes it.
- A hostile `nprofile` cannot make the browser connect to loopback or private hosts, or
  leave Tor in a Tor tab.
- Keys are not deleted while a record they control is still live.

## Open decisions

1. Default relay hints: which relays, and how many.
2. Should separate keys be mandatory for new private services, or the default with an
   opt-out? Recommended: default with opt-out.
3. Must Android support ship in the same release?
