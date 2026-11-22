# Release notes

## 0.38.0 — reachable services, onion endpoints and address changes

### Added

- **Endpoint discovery.** Publishing a local page fills the endpoint list from the
  current URL, this machine's interfaces, a global IPv6 address, an HTTPS page and any
  onion address. Every candidate carries a confidence label (`owner only`,
  `same network`, `globally routable, firewall-dependent`, `verified`, `unverified`).
- **Router classification.** The WAN address is read locally over UPnP IGD, then
  NAT-PMP. `100.64.0.0/10` is reported as carrier-grade NAT, a private WAN as double
  NAT, and a public WAN still requires a forwarding step.
- **Automatic Tor onion endpoints.** A service with a loopback endpoint gets an
  **Onion** action. The bundled Tor creates the hidden service, the address is verified
  through the browser's own SOCKS proxy, and the key is stored at `0600` so the address
  survives restarts. Stored onions are re-attached when Tor becomes ready, at launch and
  before publishing, and removed with the service or on quit.
- **Opt-in public address confirmation.** Settings → General offers `Ask` (default),
  `Always` and `Never`. The provider (`api64.ipify.org`) is named in the form, receives
  no identity or service metadata, results are cached for ten minutes, and the check
  never runs while Tor is preferred. A match with the router WAN is confirmed; a
  mismatch is called out as CGNAT or another NAT layer.
- **Explicit router port mapping.** UPnP IGD is tried first, then NAT-PMP. The mapping
  forwards one TCP port to the first private IPv4 interface, is described as
  `Nostr Navigator`, has a two-hour lease, is persisted at `0600` and is removed on
  request or quit. A non-public WAN address is refused. The mapped URL is added as
  **unverified**.
- **Reachability checks and monitoring.** A mapped port can be checked from a Tor exit
  node, an external vantage point with no extra service. While Tor is already running,
  mappings are re-checked every ten minutes; two failures raise one Services alert with
  **Check again**, and a later success clears it.
- **Address changes.** Interfaces are checked once a minute and the router WAN every ten
  minutes. A changed IPv4 address, IPv6 prefix or WAN address shows a Services banner
  with **Update & republish** (replace endpoints, sign and publish each changed service)
  and **Update endpoints only**. Per-service publish failures are reported without
  stopping the rest.
- **Site icons.** The project site now uses the application icon for its favicon, Apple
  touch icon, header/footer mark and web manifest.

### Changed

- Bundled Tor no longer starts with `--ClientOnly 1` and now exposes a loopback control
  port with cookie authentication, which is required for onion services. An external Tor
  can be used with `NCC_TOR_CONTROL` and `NCC_TOR_COOKIE` or
  `NCC_TOR_CONTROL_PASSWORD`.

### Notes

- An onion endpoint only exists while Tor and the browser run.
- A direct IPv4 endpoint still needs a port forward; discovery and confirmation never
  claim otherwise.
- A mapped port stays unverified until the Tor-exit check succeeds.

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
