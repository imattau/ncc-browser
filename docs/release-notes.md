# Release notes

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
