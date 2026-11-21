# Release notes

## 0.37.1 — private anchoring, strict publishing and multi-contact sharing

### Fixed

- **Private NCC-02 anchors** no longer expose the endpoint. A private service or share
  publishes a `kind 30059` record with `d`, `exp` and an optional `k`, but no `u`;
  NCC-05 remains the only endpoint source.
- **Strict anchoring now applies to publishing.** When Require NCC-02 service records is
  on, the anchor is written first and the locator is only published if at least one relay
  accepted it. A rejected anchor fails the service/share instead of leaving a locator that
  strict recipients would reject.
- **A private share gets its own no-`u` anchor** under its `share-…` d tag. The canonical
  service anchor does not satisfy a share because anchored resolution looks up the anchor
  by the requested d tag.

### Added

- **Share with multiple contacts.** The share picker reads the active identity's kind-3
  follow list and caches kind-0 names, NIP-05 identifiers and pictures in
  `userData/contacts.json` (0600). The cache opens instantly, refreshes after six hours or
  on demand, and is per identity. Search, select several people, or paste an npub.
- **One link per recipient.** Each recipient gets their own NIP-44 locator and no-`u`
  anchor, because NIP-44 has one conversation key per recipient. Duplicate recipients are
  collapsed, one failure does not stop the rest, and each link can be revoked or renewed
  independently.

### Site

- The project site now links the Nostr git mirror (gitworkshop.dev, announced on
  `relay.ngit.dev`) alongside GitHub, with NostrHub as a secondary index.

## 0.37.0 — hosted services and static sites

### Hosted services (desktop)

- **Settings → Services** publishes a running HTTP service as
  `ncc://<npub>/<service>`: sign an NCC-05 locator, encrypt it to yourself by default,
  publish to your relays and renew it while the browser runs.
- **Private links**: share a private service with one recipient npub. The share is the
  same payload NIP-44 encrypted to that key under a reserved `share-…` tag, with an
  expiry, copy/revoke/renew actions and a **Shared with me** list.
- The resolver treats `share-…` as exact-only, so a missing or expired share never
  falls back to the owner's generic `addr` service.
- **Menu → Publish this page…** on a loopback page, and Welcome cards for your services.

### Static sites

- **Settings → Sites** publishes a built folder as a NIP-5A site. Files are hashed and
  uploaded to Blossom (BUD-02), a `15128`/`35128` manifest is signed with the active
  identity, and published through the relay pool.
- Open, copy, verify and republish `nsite://<npub>/<site>/`; unchanged files are skipped
  by hash.
- Cancel an in-progress upload or verification. A cancelled publish writes no site or
  manifest; blobs already accepted remain on Blossom.
- The standalone site publisher from ncc-server is bundled at `nccpublish://app/` as a
  fallback.
- **Menu → Publish a site** and a Welcome card.

### Notes

- Nsite and hosted-service content is public unless the locator is shared privately;
  Blossom servers may garbage-collect unpinned blobs.
- NIP-46 signers prompt on the device for site upload authorisations and for service
  publishing.
- The Android build gets the version bump but not the desktop Services/Sites UI yet.
