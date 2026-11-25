# Release notes

## 0.47.8 — sharing contacts

### Fixed

- On desktop, the contacts offered when sharing a service now belong to the identity
  that signs it, not the one that was active when Services opened. Switching identity
  also clears recipients already chosen. An identity that follows nobody shows no
  contacts; paste the recipient's npub instead.

## 0.47.7 — private service privacy

### Fixed

- New readable records (NCC-02) for private services and shares no longer include the
  certificate fingerprint; it stays in the encrypted locator. Publishing replaces older
  records that have it, as far as the queried relays return them.
- A private service now keeps its anchor setting after a restart.
- New share links use random IDs. Older IDs could be matched to a recipient; the
  service card marks active ones. Revoke, renew and send the new link.
- The browser's HTTPS certificate no longer names your LAN address. An older one is
  replaced when its proxy starts, so publish again.

Service names, your identity, record times, expiry and size remain readable, and old
copies of records may still exist.

## 0.47.6 — HTTPS for hosted services

### Fixed

- On desktop, HTTPS added by the browser can now be reached from other devices. Saved
  endpoints stay as typed; publishing and sharing send the correct ports and
  certificate pins. Internet visitors need the router rule shown on the service card.
- Publishing or sharing turns HTTPS on when one of this computer's `https://`
  endpoints is really a plain HTTP server.
- Removing a service now stops its HTTPS proxy.
- Onion setup handles a plain HTTP server saved as `https://`.
- A failed HTTPS handshake is no longer reported as a certificate mismatch, and other
  HTTPS endpoints are tried.

## 0.47.5 — Android swipe feedback

### Improved

- Android now shows a pull-to-refresh indicator and animates tab cards as they are
  swiped closed.

## 0.47.4 — editing hosted services

### Fixed

- On desktop, saving changes to an existing service under Your services no longer fails
  with "A service id is required".

## 0.47.3 — Android swipe gestures

### Added

- On Android, swipe down on a page or the tab switcher to reload the active page. Swipe
  a tab card left or right in the switcher to close that tab.

## 0.47.2 — Android external links

### Fixed

- Android now reliably opens links shared by other apps on cold and warm starts.

## 0.47.1 — restore Android signer profiles

### Fixed

- Android identity settings now import the npub decoder used to label saved signers,
  preventing the profile list from failing to render after an identity import or refresh.

## 0.47.0 — local TLS proxy for hosted services

### Added

- Publishing a hosted service with a plain `http://` endpoint can now add a local TLS
  proxy: the browser generates and keeps a self-signed certificate, terminates TLS on
  a loopback port in front of the endpoint, and publishes that proxy's `https://`
  address pinned with the certificate's fingerprint. No certificate needs to be
  installed on the service's own server, and the address and pin stay stable across
  restarts. The plain `http://` endpoint is left in place.

## 0.46.0 — profile-aware signer selection

### Added

- Identity pickers on desktop and Android now show a profile image and username when
  available, with a shortened npub beneath the name. Pickers fall back to the npub and
  an initial avatar when profile metadata is missing or unavailable.
- Profile metadata is loaded from configured relays and cached for six hours, so signer
  selection remains usable while relays are offline.
- The service signing identity picker now uses the same profile-aware presentation as
  the other identity selectors.

## 0.45.2 — fix the release build

### Fixed

- Bumped the bundled Tor Expert Bundle to 16.0.3; 16.0.1's assets were removed from
  dist.torproject.org, which 404'd every platform's release build (this blocked
  v0.45.0 and v0.45.1 from publishing).

## 0.45.1 — site publishing identity picker

### Added

- The site publishing settings now have the same "Signing identity" picker as hosted
  services: pick an existing identity, create a new one, or use a one-off key, instead
  of always publishing under whatever identity happened to be active.

## 0.44.4 — White Noise hand-off

### Added

- Viewing an `ncc://` site you don't own now offers a "Message this owner via White
  Noise" action in the site info panel, on both desktop and Android. It opens
  `whitenoise://user/<npub>` through the OS; no signer or session state is shared with
  White Noise.
- The project website links to the project's own White Noise contact in its header,
  mobile menu and footer.

## 0.44.0 — notifications and background work

### Added

- Browser-owned notifications now report completed or failed downloads on desktop and
  Android.
- Android can keep browser work running after the app moves to the background, using
  an ongoing foreground-service notification. This is opt-in, off by default, and
  offered once on first launch; Android notification permission is requested when
  needed.
- Android settings now include a control for background work. Returning to NCC Browser
  stops the foreground service.

### Fixed

- Android home-screen shortcut icons are decoded with bounded dimensions and memory use,
  preventing malformed or oversized page favicons from crashing shortcut creation.

## 0.43.0 — add sites to the home screen

### Added

- Add a normal tab to the browser home screen on desktop and Android. Desktop also
  creates an OS desktop launcher; Android offers to pin a launcher shortcut and uses
  the page icon when available. Home screen entries can be removed from the browser.

## 0.42.3 — Android: fix all page/nsite loads hanging forever

### Fixed

- **Android: every https:// page and nsite got stuck loading forever.** Certificate
  verification (`rustls-platform-verifier`, used to check certificates against the OS
  trust store) requires an Android-side JNI init call before its first use, which the
  app never made — so every HTTPS fetch, whether a plain page or nsite content (itself
  fetched over HTTPS), panicked the worker handling it and the tab just sat there with a
  stuck progress bar instead of loading or showing an error. Reproduced live against the
  actual v0.42.1 build before fixing it; confirmed both a normal site and an nsite load
  correctly afterward.

## 0.42.2 — OAuth sign-in popups, and password vault backfill

### Fixed

- **"Continue with Google" (and similar OAuth popups) now work.** A popup was always
  denied and reopened as a disconnected tab, losing `window.opener` — which broke the
  `postMessage` handoff OAuth providers rely on to hand back the signed-in result. A
  popup sized like a deliberate sign-in/payment dialog, or opened to a known
  identity-provider host, now opens as a real auxiliary window with `window.opener`
  intact. Applies to Android too (WebView's `onCreateWindow`, same underlying problem).
- **Google Sign-In's FedCM path no longer errors out before the popup even opens.**
  Electron exposes the FedCM JS surface but has no working implementation behind it;
  FedCM is now disabled at the Chromium level so sites fall back to the popup flow.
- **The app no longer appears to freeze after a sign-in popup closes.** The auxiliary
  popup window has no native parent (some Wayland compositors don't support the
  `xdg_foreign` protocol that would need), which could leave the main window never
  getting input focus back. Focus is now reclaimed explicitly when the popup closes.
- **A self-closing popup (e.g. once an OAuth flow finishes) no longer crashes the app
  or leaves a dangling tab.** A tab whose `WebContentsView` destroys itself out from
  under it (the page calling `window.close()`) is now cleanly removed.
- **Every local Nostr identity now gets a recovery copy of its nsec in the password
  vault**, not just ones freshly generated in-app. A key's nsec was previously only
  ever saved to the vault at the moment it was generated — never on import, and never
  retroactively for an identity that already existed. Importing now saves it too, and
  existing identities are backfilled on the next unlock (a deliberately deleted entry
  is not recreated).

## 0.41.0 — agent sign-in, self-publishing nsite client, and profile display

### Added

- **An agent can sign in to sites as itself.** A tab opened by an agent's own `tab_new`
  call now answers `window.nostr` (NIP-07) with that agent's own identity, not the
  human's. Signing in is a second, independent approval track from site access, each
  with its own revoke/"stop" control in Agent control.
- **`agent-client/`**: a single-file, no-build nsite built for automation agents to
  drive — sign in, set a profile and avatar, follow and unfollow accounts, post, read a
  simple feed, and republish the exact same site under whoever is signed in (no
  re-upload, since nsite files are content-addressed). Verified end-to-end as a live
  connected agent.
- **Agent control shows each agent's own profile and nsite.** A best-effort, cached,
  non-blocking relay lookup surfaces an agent's name, avatar and nsite address next to
  its npub, with its own refresh control.

### Fixed

- `saveAgentSecret` after an upstream refactor split the password vault's relay-sync
  engine out of `PasswordService`.
- The nccsearch/site-publisher prebuild scripts now fall back to a plain `npm` lookup
  (through a shell) when an inherited `npm_execpath` turns out not to be runnable.

## 0.40.1 — per-agent Nostr identities for Agent control

### Added

- **Each automation agent gets its own Nostr identity.** Settings → Agent control now
  lists named agents instead of one shared token; adding an agent generates a Nostr
  keypair whose nsec is its MCP connection credential, saves that nsec in the password
  manager, and gives the agent its own independent site-approval grants. The connect
  command is shown in full once, then stays masked behind a “Reveal” button that
  requires the password manager to be unlocked.

## 0.40.0 — password health and per-tab transport

### Added

- **Password strength and vault health.** The add/edit login form now scores each
  password locally, and Settings → Passwords can scan the unlocked vault for weak,
  reused and stale entries against a configurable rotation window. Scoring never
  leaves the machine or touches a relay.

### Fixed

- **Transport is tracked per tab.** A Tor tab showing an onion document no longer
  marks a normal tab for the same service as “over Tor” — which also stopped that
  tab's subresources from being fetched through Tor.
- **Quitting keeps the open tabs.** The empty window written during shutdown no
  longer replaces the real session, so the next launch does not restore a blank
  window.

### Changed

- **Smaller, independently testable main-process modules.** The browser shell,
  bootstrap, settings, wallet, hosting discovery and password vault were split
  into focused modules, with import-boundary lint and 720 unit tests. Selectors,
  visible text and shortcuts are unchanged.

## 0.39.3 — deletion requests for nsites

### Added

- **Removing a site publishes a NIP-09 deletion request.** The signed `kind 5` event
  carries an `a` tag for the site address (`35128:<pubkey>:<siteId>`, or
  `15128:<pubkey>:` for the root site) and an `e` tag for the manifest, and is sent to
  the site relays before the local record is removed. If there is no identity, the
  active identity does not own the site, or no relay accepts it, the removal stays
  local and the UI reports why.
- **Discovery respects deletions.** It queries the owner's `kind 5` events and skips a
  manifest whose event id was deleted or whose address has a deletion at or after its
  `created_at`.
- **Restoring a deleted site** works by republishing the same site id from its source
  folder. The new manifest has a newer `created_at`, so it wins over the deletion and
  clears the hidden entry.

## 0.39.2 — address before endpoints and opt-in public reachability

### Added

- **The service address can exist before its endpoints.** `ncc://<npub>/<service>` is
  derived from the identity and service id; the Add service form shows and copies it,
  and you can save the service without endpoints. **Publish** and **Share** still need
  a reachable endpoint and say so.
- **The discovered public address is explicitly opt-in.** It has its own
  “Include … in the locator” checkbox under Internet reachability instead of sharing the
  general candidate list.
- **Local network only** hides public and current-page candidates and removes any
  selected discovered public URLs (and their pins), leaving loopback/LAN/IPv6
  candidates untouched.
- **Duplicate site records** for the same owner and site id are replaced instead of
  multiplied; an old index with duplicates now keeps the newest record.

## 0.39.1 — rediscover published sites

### Fixed

- **A previously published site no longer disappears from Sites.** The page only read
  the local `nsite-sites.json` index. Opening Sites now queries the configured and
  NIP-65 relays for the active identity's latest kind 15128/35128 manifests and rebuilds
  missing entries. A **Find published** button runs the same lookup on demand.
- **Removed sites stay removed.** Deleting a site records it in the index's hidden list,
  so relay discovery does not bring it back. Republishing the same address clears the
  hidden entry, and the page shows how many removed sites are hidden.

## 0.39.0 — service identities, TLS certificates and standalone discovery

### Added

- **Choose the identity for a service.** The Add service form lists every saved
  identity and reuses the selected one, so an existing signer no longer has to be
  recreated.
- **One New identity button with an Add to identity list checkbox.** Checked creates a
  saved local identity; unchecked creates a one-off identity for this session, shows
  its nsec, and can be promoted later. The promotion checkbox is disabled once the npub
  is already saved. Switching away from or replacing a one-off asks for confirmation.
- **TLS certificates for HTTPS endpoints.** Import a PEM/DER certificate to derive the
  NCC-05 `k` pin, or generate a self-signed certificate with SANs for every endpoint
  host. Generated `<name>-cert.pem` and `<name>-key.pem` (key `0600`) are written to a
  folder you choose. Matching endpoints switch to `https://` and carry the pin; a
  certificate that does not name an endpoint host leaves it unpinned. The browser does
  not terminate TLS; install the files in the server.
- **Find endpoints without opening a page.** Enter a port (or use the first endpoint,
  then 80/443); discovery scans this machine's IPv4/IPv6 addresses, reports whether Tor
  is running, and offers candidates as checkboxes. With a TLS pin it produces HTTPS
  candidates; otherwise HTTP.
- **`nsite://` bookmarks.** nsite addresses can be bookmarked and now sync with tabs and
  history; the bookmark action no longer silently does nothing.

### Changed

- **Sharing after adding.** Adding a private service opens Share immediately so the
  contact list is visible. The intro now describes the contact-list flow instead of
  “share with one npub”.
- **Loopback-only services** show a warning in Share and cannot create links until a
  LAN, public or `.onion` endpoint exists.
- **Bare endpoint addresses** such as `192.168.1.20:8080` or `[2001:db8::1]:8080` are
  accepted and default to HTTP; an explicit `https://` keeps TLS. Editing a service
  preserves its existing TLS pins.

## 0.38.1 — main-process TLS crash fix

### Fixed

- **The main process no longer crashes while loading.** Node's global `fetch` could
  abort with `AssertionError: assert(this.paused)` in `Parser.finish` when a TLS server
  closed a response mid-stream. The startup filter-list download used it, so the app
  could show “A JavaScript error occurred in the main process” on launch. Protection
  lists, UPnP discovery and the public address lookup now use a `node:http`/`node:https`
  helper with a hard timeout, a response size cap and explicit redirects.
- **NCC conventions link.** The site now points at
  `github.com/imattau/nostr-community-conventions` instead of a 404 path.

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
