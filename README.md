# Nostr Navigator

A desktop browser that resolves services by **Nostr identity instead of DNS**.

Type `ncc://<npub>/<service>` and the browser fetches an NCC-05 locator (kind `30058`)
from Nostr relays, verifies the signature and TTL, and renders whatever the owner is
currently serving — no domain, registrar, or Dynamic DNS in the path.

Built with Electron 45, React 19, and Vite. The resolver is a spec-correct
implementation on top of `nostr-tools`, not a wrapper around `ncc-05-js` (see
[Why not `ncc-05-js`](#why-not-ncc-05-js)).

**Status:** M0–M9 are implemented. That includes the resolver, proxy and pinning, the
browser chrome and signer, NCC-02 anchoring with a trust panel, the separate publisher
app in [`publisher/`](./publisher/) (a NIP-07 flow for NCC-05 locators and NCC-02 service
records), bundled Tor with the onion preference/toggle and full Tor tabs, private tabs,
HTTPS policy and HTTP warnings, and packaged Linux, macOS and Windows releases.

![Start screen](./docs/welcome.png)

| Tabs | Failure page | Settings page |
| --- | --- | --- |
| ![Two tabs with a resolved service](./docs/tabs.png) | ![No locator published](./docs/error-page.png) | ![Settings page with identity and remote signer](./docs/settings.png) |

| Downloads | Tab history | Site information |
| --- | --- | --- |
| ![Downloads panel with progress and reveal](./docs/downloads.png) | ![Per-tab history panel](./docs/history.png) | ![Site information panel with anchor details](./docs/trust.png) |

| Browser menu | Settings: relays & anchoring | Publisher |
| --- | --- | --- |
| ![Hamburger menu with grouped commands](./docs/menu.png) | ![Relays and NCC-02 anchoring settings](./docs/settings-general.png) | ![NCC Publisher with signer and result](./docs/publisher.png) |

---

## Quick start

```bash
npm install
npm run dev      # Electron + Vite with HMR
```

Open an address:

```
ncc://npub1…/web
ncc://npub1…/web/docs
```

The address bar also accepts `npub1…/web`, `ncc:npub1…/web`, and plain `http(s)://`
URLs. A URL passed on the command line opens on launch:

```bash
npm run build
npx electron . 'ncc://npub1…/web'
```

---

## Publishing a service

[`publisher/`](./publisher/) is a separate single-page app that publishes a locator for a
service running on a local port. It asks a **NIP-07** provider to sign; it never handles
an `nsec`.

```bash
npm install               # root dependencies also cover the publisher
npm run publisher:dev     # http://localhost:5173
```

You can also `cd publisher && npm install && npm run dev`.

Open that URL in Nostr Navigator to use the built-in signer (the approval sheet appears as
usual), or open it in a normal browser with a NIP-07 extension. Fill in the service id,
host/port, relays, and publish. The result is:

```
ncc://<your npub>/<service>
```

The publisher emits a `kind 30058` locator (plaintext or NIP-44-encrypted to your own
key) and, by default, a `kind 30059` NCC-02 anchor with the primary endpoint and optional
TLS `k`. Use `127.0.0.1` when the publisher and browser are on one machine; use a LAN
address and open the firewall for another device.

Build the static app with `npm run publisher:build` (`publisher/dist`). See
[`publisher/README.md`](./publisher/README.md) for the operational details.

---

## Browser chrome

The window is frameless: the tab strip doubles as the title bar, with a drag region and
in-app minimize/maximize/close controls. No native menu bar; every command lives in the
toolbar's hamburger menu, and shortcuts are routed by the main process so they keep
working while the remote page has focus.

- **Tabs** — new/close/switch, middle-click close, drag to reorder, per-tab favicon,
  title and loading spinner. Playing audio shows a speaker icon (click to mute), and an
  overflow button appears when the strip cannot fit every tab, with a searchable list.
  Right-click a tab for reload, duplicate, mute, copy address, close, close others and
  close to the right. A blank tab shows the welcome screen.
- **Private tabs** — a separate in-memory session, a mask indicator and `Ctrl+Shift+N`.
  Cookies, cache, history and remembered signer permissions are dropped when the last
  private tab closes. Private tabs are never written to the restore session.
- **Tor tabs** — a full Tor tab (`Ctrl+Shift+O`) routes page traffic, downloads and NCC
  relay lookups through Tor, disables WebRTC leaking, and is always ephemeral. It is
  separate from the per-locator onion preference.
- **Toolbar** — back/forward (right-click or hold for a jump list), reload/stop
  (the refresh button bypasses the HTTP cache), history, address bar with a
  colour-coded padlock and bookmark star, downloads with progress, identity key,
  hamburger menu.
- **Tor** — release builds bundle Tor; Settings → General has **Prefer Tor connections**
  and an automatic/local SOCKS proxy choice. With the preference off, a locator that
  publishes an onion endpoint gets an onion button in the address bar; clicking it
  reloads that service over Tor, clicking again returns to direct. Direct `.onion` URLs
  work too.
- **Settings** is a page, not a modal: `General`, `Security`, `Identity & signer`,
  `Trusted services` and `About`, with a back-to-browsing button. `Esc` also leaves it.
  **Security** controls Off / Prefer HTTPS / HTTPS only, the optional HTTP interstitial,
  and the list of persisted HTTP exceptions.
- **Shortcuts** (also shown in the menu): `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab` /
  `Ctrl+Shift+Tab`, `Ctrl+Shift+N` (private tab), `Ctrl+Shift+O` (Tor tab), `Ctrl+L`,
  `Ctrl+R`, `Ctrl+Shift+R`, `Ctrl+.`, `Ctrl+D` (bookmark), `Ctrl+H` (history),
  `Ctrl+J` (downloads), `Alt+←/→`, `Ctrl++/-/0`, `Ctrl+Shift+I/J`, `Ctrl+Q`. On macOS
  `Cmd` replaces `Ctrl`. `Ctrl+R` is a normal reload; the toolbar
  refresh uses the `Ctrl+Shift+R` path (clear the content session cache, then reload).
- **Right-click content** — links (open in new tab, copy address), images (open, copy
  address, save), editable fields (cut/copy/paste/select all), plus back/forward/reload
  and inspect element.
- **Downloads** — a session list that survives chrome reloads, with byte progress,
  cancel, reveal in folder, and clear-finished. Files are saved under `~/Downloads`
  unless `NCC_DOWNLOAD_DIR` is set.
- **History** — the toolbar and `Ctrl+H` list every entry in the active tab; selecting
  one jumps straight to it. History is per tab and can be cleared from the panel.
- **Bookmarks** — the star in the address bar toggles the current page; the hamburger
  menu lists bookmarks with remove buttons. They are local to this browser.
- **Session restore** — normal tabs, the active tab and window geometry are saved to
  `userData/session.json` and restored on the next launch. Private and Tor tabs are never
  restored; only addresses are stored.
- **Window title** follows the active page.

---

## Address model

```
ncc://<npub>/<service>/<path…>?<query>
```

| Segment | Meaning |
| --- | --- |
| `npub` | Owner's Nostr public key. This is the trust anchor. |
| `service` | Locator namespace (`d` tag). Omitted → `addr`. |
| `path` | Forwarded verbatim to the resolved endpoint. |

Because publishers disagree about the `d` tag, the resolver probes, in order:
`<service>`, `<service>-locator` (the `ncc-sidecar` convention), then `addr`. The first
fresh, valid record wins and the matched tag is reported in the UI.

---

## How resolution works

1. Decode the npub to hex.
2. Query configured relays once for
   `{kinds:[30058], authors:[hex], '#d':[candidates]}`.
3. When gossip is on, also fetch the identity's NIP-65 relay list (kind `10002`) and
   add its read/both relays to the same query (capped at 8, read-only entries).
4. Verify every event signature and author.
5. Select the newest record per `d` tag (`created_at` desc, then lexicographically
   smallest `id`).
6. Decode the payload: plaintext JSON, or NIP-44 if a signer is configured.
7. Enforce expiry: the earliest of the `expiration` tag and `updated_at + ttl`.
   Expired records are never used.
8. Normalise endpoints (`url` / `uri`, scheme-less values, `tcp`→`http`), sort by
   priority (default `1000`) and family, then try them in order.
9. Cache in memory until `expiry` (capped at 120 s so rotations are noticed) and write
   public records to `userData/locator-cache.json` for fast, restart-safe resolution.
   Encrypted records are never persisted. Failures are negative-cached for 15 s, and
   failed endpoints cool down with exponential backoff (15 s → 5 min).

Each failure gets its own page: `invalid-address`, `no-record`, `expired`,
`undecryptable`, `invalid-payload`, `no-endpoint`, `relay-error`, `timeout`, and
`endpoint-unreachable`.

---

## Proxying and transport security

The `ncc://` scheme is registered as a privileged, standard, secure scheme. The content
session handles **every** request under the origin, not just top-level documents, so:

- relative and absolute-path subresources work without CORS;
- the page never learns the real `ip:port`;
- one `npub` is one origin, so cookies and storage isolate owners naturally;
- redirects are rewritten back into `ncc://…` (redirects to other hosts are treated as
  "leave NCC" and passed through).

When a locator endpoint is `https` and carries `k`, the SPKI fingerprint is pinned for
that hostname via `setCertificateVerifyProc`, DANE-style:

- match → accept, including self-signed certificates and IP-literal hostnames;
- mismatch → hard refusal (`k-mismatch`), never a fallback;
- no `k` → Chromium's normal CA verification applies.

Chromium reports every refused certificate as a generic `net::ERR_FAILED`, so the verify
proc records *why* it refused and the protocol handler consumes that record to show
`k-mismatch` or `certificate-expired` instead of a vague "unreachable".

The address bar has one padlock instead of separate transport and trust chips:

- **green** — secure TLS, either pinned (the endpoint certificate matches the signed
  `k`) or CA-validated, with a green dot when NCC-02 anchoring is present;
- **amber** — plaintext HTTP (the locator is signed, the content is not authenticated);
- **red** — the page failed security or resolution (`k-mismatch`, `no-anchor`,
  `no-record`, …).

Clearnet pages use the same padlock: green for HTTPS, amber for plaintext HTTP, and red
when the page fails to load. Clicking the padlock opens **Site information**, where
pinned TLS is marked `k verified`; it also shows transport, host, NCC-02 anchor, `u`/`k`,
expiry and the failure explanation. The small dot is the anchor state (green anchored,
amber expired/invalid, grey unanchored). `TESTKEY:`-style placeholder fingerprints are
treated as “no pin”, not as a match.

Locator content is decrypted only when an encrypted record is addressed to you. The
identity from the settings page is used for that automatically; there is no separate
locator key.

---

## Tor and onion services

Locators may publish `.onion` endpoints. They are normal `http`/`https` URLs whose
hostname ends in `.onion`; the resolver tags them `family: 'onion'` and the transport
layer decides whether to use them.

- **Bundled Tor** — release builds include the official Tor Expert Bundle for their
  platform. The browser starts it lazily on the first onion request, on a private
  loopback SOCKS port, with a data directory under `userData/tor`. If the bundled binary
  is missing or cannot bootstrap, it falls back to a local proxy on `127.0.0.1:9050` or
  `9150` (a Tor daemon or Tor Browser).
- **Settings → General → Tor** — **Prefer Tor connections** uses the onion endpoint
  automatically whenever the locator publishes one; records without an onion endpoint
  still load directly. **Tor proxy** selects automatic (bundled) or a specific local
  SOCKS5 proxy; **Test connection** reports the active proxy and any bootstrap error.
- **Manual toggle** — with the preference off, an onion button appears at the right of
  the address bar whenever the locator has an onion endpoint. Clicking it force-reloads
  that `pubkey:service` over Tor; clicking again returns to its direct endpoints. The
  address stays `ncc://…`.
- **Direct onion URLs** — typing `http://something.onion` works too. A PAC sends only
  `*.onion` hosts to Tor; clearnet traffic stays on the normal path.
- **Fail closed** — if Tor is selected but unavailable, or a locator is onion-only and
  the preference is off, the browser shows `tor-unavailable` / `onion-only` instead of
  silently connecting directly.
- **Strict page isolation** — a page loaded over Tor may load only `ncc://`, inert local
  schemes and `.onion` resources. Clearnet subresources, WebSockets and redirects are
  blocked so the request cannot reveal the user's IP. Pages that depend on clearnet CDNs
  will lose those assets; load them without Tor if that is acceptable.
- **Security display** — HTTP onion pages keep the amber padlock (HTTP is still HTTP),
  but the onion button and **Site information** explain that Tor provides the encrypted
  transport and authenticates the onion address. HTTPS onion endpoints still use `k`
  pinning.

Tor updates are security updates. The version and per-asset SHA-256 pins live in
[`scripts/tor-version.json`](./scripts/tor-version.json); `npm run tor:fetch` stages them
for local packaging, and the release workflow downloads the same pins. The staged bundle
ships Tor's BSD licence and a source notice alongside the binary.

---

## Private tabs

Private tabs use an in-memory content session (`ncc-private`) separate from normal
browsing. All private tabs share it, so a login works across private tabs, but the
session is cleared when the last private tab closes.

- Cookies, cache, auth cache and host resolver cache are cleared with the session.
- The on-disk locator cache is bypassed; resolutions stay in memory.
- NIP-07 “Always allow” decisions are **session-only**. Private tabs neither inherit nor
  write the persistent trust list; the approval sheet says “Remember for this session”.
- Download metadata is marked `private` and removed when the session ends; downloaded
  files remain on disk.
- History is already per-tab and disappears with the tab. Bookmarks can still be created
  deliberately.
- Private tabs are never written to `session.json`; a private-only session restores as a
  blank normal tab.

The tab strip uses a mask indicator, the address bar shows a **Private** badge, and
`Ctrl+Shift+N` opens a new private tab.

---

## Tor tabs

A Tor tab is stronger than the per-locator onion toggle. It uses a separate in-memory
session (`ncc-tor`) with a **fixed SOCKS5 proxy for every request**:

- Clearnet pages, NCC endpoint fetches, subresources and downloads go through Tor.
- NCC-05 relay queries from a Tor tab use a Tor-aware WebSocket pool, so relays do not
  see the user's IP or the npub being resolved.
- WebRTC is set to `disable_non_proxied_udp` for the tab.
- Endpoint selection prefers an onion endpoint, otherwise uses the published clearnet
  endpoint over Tor. The address bar shows a permanent **Tor** badge instead of the
  per-page onion toggle.
- Tor tabs are always ephemeral: no cookies/storage or session restore, no persistent
  locator cache, no persistent NIP-07 permissions.
- If Tor cannot start, the tab fails with `tor-unavailable`; it never falls back to a
  direct connection.
- The approval sheet warns that **NIP-46 remote-signer relay traffic is not routed
  through Tor** yet; NCC relay lookups and page traffic are.

`Ctrl+Shift+O` opens a Tor tab. Tor tabs and the global **Prefer Tor connections** setting
are independent: the setting controls endpoint choice in normal/private tabs, while a Tor
tab always proxies all traffic.

---

## Secure connections and HTTP warnings

Settings → **Security** controls the HTTPS policy:

- **Off** — navigate HTTP normally; the amber warning bar still appears.
- **Prefer HTTPS** — try HTTPS first. If it fails, fall back to HTTP after the optional
  interstitial. This is the default.
- **HTTPS only** — never load HTTP silently. The browser either uses a published HTTPS
  endpoint or shows a blocking `HTTPS is unavailable` interstitial with an explicit
  continue/exception.

Details:
- Loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) and `.onion` services are exempt
  from automatic upgrades. Tor-encrypted onion HTTP is not made TLS.
- NCC endpoints are never rewritten to invented HTTPS ports. The resolver prefers an
  HTTPS endpoint the publisher actually published, then falls back according to the
  policy.
- **Ask before loading HTTP pages** adds a blocking interstitial for clearnet HTTP URLs
  and a self-contained warning page for NCC HTTP endpoints. The page only loads after
  **Continue once** or **Always allow this host**.
- The amber banner always appears on HTTP pages: “Not secure” for clearnet and “HTTP
  over Tor” when Tor provides the path but there is no TLS.
- “Always allow” exceptions persist for normal tabs and live only for the current private
  or Tor session. Settings → Security lists and clears persisted exceptions.
- NCC HTTP exceptions are bound to the `ncc://<npub>/<service>` service, not the raw
  endpoint host, so a locator rotation does not silently disable the warning.

---

## NCC-02 anchoring and trust

NCC-02 service records (`kind 30059`) are the identity and trust anchor for a service;
NCC-05 supplies the reachable endpoint. The browser is in **optional anchoring** mode by
default: it uses a fresh NCC-02 record when one exists and flags the service as
`unanchored` when it does not. Settings → General → **Require NCC-02 service records**
turns that into a hard requirement.

- **Site information** — click the address-bar padlock for the service id, anchor event,
  `u` endpoint, `k`, key relation, expiry and transport. A red padlock means the page
  failed; its panel carries the error code and explanation.
- **Fallback** — when NCC-05 has no usable endpoint, a valid NCC-02 `u` endpoint can
  serve the page (marked as an NCC-02 fallback). This is how a private service with no
  public locator still works.
- **Key binding** — a comparable NCC-02 `k` fills in a missing endpoint fingerprint; if
  NCC-02 and NCC-05 advertise different fingerprints for the same origin, the endpoint
  is refused (`anchor-k-mismatch`). A key is only applied to an `https` endpoint.
- **Required mode failures** — `no-anchor`, `anchor-expired` and `anchor-invalid` have
  their own error pages. Optional mode keeps browsing and shows the anchor status in the
  toolbar.
- **Expiry** — `exp` is enforced; a record without `exp` is accepted for compatibility
  and shown as “no exp tag”.

Attestations (`kind 30060`) and revocations (`kind 30061`) are not evaluated yet.

---

## Nostr identity and NIP-07

The browser has a built-in signer, so pages get a normal `window.nostr` without any
extension. It is available on **top-level `ncc://` pages and clearnet pages**, and it is
not injected into subframes or into the trusted chrome.

Supported methods: `getPublicKey`, `signEvent`, `nip04.encrypt/decrypt`,
`nip44.encrypt/decrypt`, and `getRelays`.

The identity can be either a **local key** or a **NIP-46 remote signer**; pages cannot
tell the difference.

- **Signing never happens in the page.** Pages send a request over IPC; the main process
  signs locally or forwards it to the remote signer, and returns only the result.
- **Local keys at rest** are encrypted with Electron `safeStorage` (OS keychain). If no
  keychain is available, the key stays in memory for the session and the UI says so.
- **Approval is per service.** The first request opens an in-app sheet over the page,
  showing the exact event being signed; "Always allow" is remembered per
  `ncc://<npub>/<service>` for NCC pages, and per origin for clearnet. While the sheet is
  open the remote page is hidden, so it cannot fake or cover the prompt. Settings →
  Trusted services lists remembered origins with a revoke button.
- **Validation** rejects malformed kinds, non-string tags, events more than 15 minutes in
  the future, and content over 1 MB before anything reaches the signer.
- **Development overrides:** `NCC_IDENTITY_NSEC` loads a local key from the environment,
  `NCC_SIGNER_AUTO_APPROVE=1` skips the approval sheet, and `NCC_NIP46_TIMEOUT_MS`
  changes the remote-signer timeout (default 60 s). All three are for development/e2e.

The toolbar has a key icon for the current identity (accent when configured, with a
pending dot when a request is waiting). Clicking it opens the **Identity & signer** page.

Settings → Identity & signer imports an `nsec` (or 64-char hex), generates a new
identity, shows the npub, and removes it.

![In-app signer approval](./docs/approval.png)

### Remote signing (NIP-46)

Settings → Identity & signer → **Remote signer** accepts a `bunker://` URL (Amber,
Nostr Connect, nsec.app, …). The flow is:

1. The browser generates a **client key** used only to encrypt the NIP-46 channel and
   signs the connect request.
2. The remote signer approves the connection on the user's device; the browser stores
   the session (remote pubkey, relays, secret, encrypted client key) in `userData`.
3. Every NIP-07 call becomes a `kind 24133` request to the signer. The browser still shows
   its own per-service approval first, so the user sees *which service* is asking; the
   device then confirms the signature.
4. Disconnecting removes the session and falls back to any saved local key.

Targeted NCC-05 locators work too: the browser calls the signer's `nip44_decrypt` with
the publisher's pubkey instead of deriving a conversation key, so the identity key never
has to exist locally. A signer that does not implement `nip44_decrypt` can still browse
public locators.

NIP-46 sessions are encrypted with `safeStorage` like local keys. Without an OS keychain
the session is ephemeral and must be reconnected after a restart.

### Why Nostrify?

Only the NIP-46 client uses [`@nostrify/nostrify`](https://nostrify.dev/): `BunkerURI`
for parsing, `NConnectSigner` for request correlation, encryption negotiation and
response validation, and `NPool`/`NRelay1` for multi-relay transport. That is the part
where hand-rolling tends to produce subtle bugs. It is bundled into the main process
only; the renderer and the NCC resolver still use `nostr-tools` directly, and no Nostrify
state or React bindings leak into the UI.

### Why not browser extensions?

Chrome extension content scripts only match `http`, `https`, `file`, and `ftp` URLs. A
signer extension (nos2x, Alby, …) can therefore never inject into an `ncc://` page, no
matter how Electron loads it. Electron also cannot install extensions from the Chrome Web
Store, only unpacked ones, and MV3 extension support is partial. For NCC pages the
built-in provider is the only mechanism that works; unpacked extension support for
clearnet pages is a possible later addition.

---

## Architecture

```
src/main
  index.ts           app lifecycle, launch address, identity wiring
  shell.ts           BrowserWindow (chrome) + one WebContentsView per tab
  protocol.ts        ses.protocol.handle('ncc') — resolve, fetch, rewrite, error pages
  pins.ts            SPKI pin store + setCertificateVerifyProc
  config.ts          relays, anchoring, Tor, HTTPS policy and HTTP exceptions
  sessions.ts        normal/private/Tor content sessions and their lifecycle
  security.ts        pure HTTPS policy, HTTP exceptions and warning tokens
  tor/manager.ts     bundled/local Tor lifecycle, bootstrap, fallback
  tor/proxy.ts       pure: SOCKS5 validation, probe, onion-only PAC
  tor/session.ts     loopback PAC server + fixed proxy for full Tor tabs
  tor/relay.ts       Tor-routed Nostr relay WebSocket pool
  tor/guard.ts       strict per-tab allowlist for resources loaded over Tor
  cache-store.ts     on-disk locator cache (public records only)
  bookmarks.ts       local bookmarks, persisted to userData
  session-store.ts   saved tabs + window geometry for session restore
  downloads.ts       download manager: sanitised names, progress, cancel, reveal
  favicon.ts         fetch page icons, convert to bounded data URLs
  ipc.ts             navigate / tabs / history / bookmarks / downloads / window / commands
  error-page.ts      self-contained failure screens
  shortcuts.ts       pure: key event → command
  context-menu-model.ts  pure: context menu contents
  context-menu.ts    native context menus for content and chrome
  ncc/locator.ts     pure: candidates, payload validation, endpoint normalisation
  ncc/anchor.ts      pure: NCC-02 parse/select, k application, u fallback
  ncc/resolver.ts    relay query, gossip, anchoring, decrypt, cache, dedupe
  ncc/routing.ts     pure: path joining and Location rewriting
  ncc/transport.ts   pure: direct/onion endpoint selection + per-service overrides
  ncc/health.ts      endpoint cooldowns
  signer/crypto.ts   pure: template validation, signing, NIP-04/44
  signer/identity.ts encrypted local key storage (async safeStorage codec)
  signer/permissions.ts  per-service approvals
  signer/provider.ts local identity provider
  signer/nip46.ts    NIP-46 provider (Nostrify BunkerURI/NConnectSigner/NPool)
  signer/session.ts  persisted NIP-46 session (encrypted client key)
  signer/manager.ts  one active identity: local key or remote signer
  signer/service.ts  approvals queue, delegates to the active provider
  signer/ipc.ts      NIP-07 IPC, caller origin derived from the main frame
  approval.ts        in-app approval broker (chrome sheet, content hidden)
src/preload
  index.ts           contextBridge → window.ncc (chrome only)
  content.ts         contextBridge → window.nostr (top-level page frames only)
src/renderer         React chrome: tabs, toolbar, menu, downloads, history, settings,
                     security banner/interstitial, signer sheet, welcome
src/shared           ncc:// parser, types, relay validation, commands, tab order,
                     download formatting (no Node imports)
publisher/           separate Vite/React/Tailwind app: NIP-07 locator + NCC-02 publisher
```

Remote content runs with `sandbox: true`, `contextIsolation: true`, no Node, and its own
`persist:ncc-content` partition. Its only exposed surface is `window.nostr`; there is no
general IPC bridge.

---

## Testing

```bash
npm test       # 263 unit tests: URL parser, locator rules, resolver, routing, pins,
               # signer crypto, identity storage, NIP-46, approvals, permissions,
               # ephemeral signer permissions, shortcuts, context menus, relays,
               # downloads, tab order, bookmarks, favicons, session storage, NCC-02
               # anchoring, Tor transport selection, proxy/PAC validation, Tor manager
               # fallback, HTTPS policy/exceptions, clearnet lock state, publisher events
npm run e2e    # real Electron window against a mock relay and local HTTP services
```

The end-to-end test starts a WebSocket relay, signs real `30058` and `30059` events,
serves an HTTP page with an external stylesheet, a favicon, a downloadable file, and two
self-signed HTTPS services, builds and serves the publisher app, then drives the running
browser over the Chrome DevTools Protocol. It asserts rendering, subresource proxying,
relative-link resolution, the synthetic origin, the address bar, the colour-coded
padlock and its site information panel, refusal of a certificate that does not match
`k`, `ncc://` link-driven
service switching, NIP-65 gossip to a second relay, tab open/close, drag reordering, mute
state, tab overflow, the persistent cache and session file on disk, **session restore
across a real app restart**, the full NIP-07 path (in-app approval sheet, focus
containment, public key, verifiable signature, NIP-04/44 round-trips, no provider in
subframes), NCC-02 anchoring (trust panel, `u` fallback, required-mode refusal), the
settings page, the downloads panel (a real file written to disk), the per-tab history
panel, bookmarks, a toolbar refresh against a `max-age` cached document, Tor transport
(the onion toggle, automatic preference, strict clearnet blocking, direct `.onion`
navigation, onion-only and Tor-unavailable failures against a fake SOCKS5 proxy), a
**full Tor tab** whose page, endpoint and relay lookups all hit the fake SOCKS proxy,
**private tab cookie isolation and clearing**, private-tab session-restore exclusion,
HTTPS endpoint preference, the HTTP warning banner, clearnet and NCC HTTP
interstitials/exceptions, the hamburger menu, **real global shortcuts sent through X**
(Ctrl+T/W/L while the page is focused), a **real NIP-46 round-trip against a mock
bunker** — connect, remote signing, remote decryption of a targeted locator, and
disconnect — and the **publisher app publishing through the built-in signer and being
resolved back by the browser**. Screenshots land in `/tmp/opencode/ncc-browser-e2e/`.

To try it against a real publisher, run [`ncc-sidecar`](../nostr-community-conventions/ncc-06/ncc-sidecar/)
or [`ncc_publish.py`](../nostr-community-conventions/ncc_publish.py), point both sides at
the same relay, and open `ncc://<their npub>/<service>`.

---

## Why not `ncc-05-js`

The reference resolver has three behaviours that are fatal for a browser addressing
individual services (all verified in source):

1. it queries `30058` without a `#d` filter and keeps only the author's single freshest
   event, so on a multi-service identity the older services become unresolvable;
2. it decrypts only that one newest candidate, so an undecryptable record ends
   resolution instead of falling through to the next candidate;
3. with `strict: false` it returns expired payloads, making "expired" indistinguishable
   from success.

`src/main/ncc/resolver.ts` implements the NCC-05 algorithm directly and keeps the
selection and freshness rules unit-tested. The remaining upstream issues are listed in
[PLAN.md §8](./PLAN.md#8-upstream-fixes-worth-filing-on-nostr-community-conventions).

---

## Relationship to MKStack

MKStack is a web-app framework: it cannot register a custom scheme, bypass CORS to a raw
`ip:port`, pin a TLS SPKI, or control navigation, so it cannot be the browser itself.

The renderer deliberately uses the same stack MKStack generates (React 19 + Vite +
TypeScript + Tailwind + small shadcn-style components). The M4 publisher lives in
[`publisher/`](./publisher/) and uses the same stack; the Stacks alias was unreachable
from this environment, so it was built directly rather than generated with
`stacks clone mkstack`. It still follows the intended split: the publisher handles the
NIP-07 publishing flow and key material never enters this browser's trusted chrome.
See [soapbox.pub/mkstack](https://soapbox.pub/mkstack).

---

## Packaging and releases

Releases are built by [`.github/workflows/release.yml`](./.github/workflows/release.yml)
from a version tag. The workflow runs the typecheck and unit tests once, then builds on
three runners and attaches every artifact to a single GitHub release:

| Platform | Artifacts |
| --- | --- |
| Linux | `ncc-browser-<version>-linux-amd64.deb`, `…-linux-x86_64.rpm`, `…-linux-x86_64.flatpak` |
| macOS | `ncc-browser-<version>-mac-x64.dmg` / `-arm64.dmg` and matching `.zip` |
| Windows | `ncc-browser-<version>-win-x64-setup.exe` (NSIS) |

The release job also uploads `SHA256SUMS.txt`. Pushing a tag is the whole release flow:

```bash
npm version patch --no-git-tag-version   # or edit package.json
git commit -am "Release v0.1.4"
git tag -a v0.1.4 -m "Nostr Navigator v0.1.4"
git push origin main --follow-tags
```

The workflow rewrites `package.json` to the tag version before building, so pre-release
tags such as `v0.2.0-beta.1` are published as a GitHub pre-release. A manual
`workflow_dispatch` run builds and uploads the artifacts without creating a release.

To build locally:

```bash
npm run dist:linux   # deb + rpm + flatpak (needs rpm, flatpak and flatpak-builder)
npm run dist:mac     # dmg + zip for x64 and arm64 (run on macOS)
npm run dist:win     # NSIS installer (run on Windows)
```

Each `dist:*` script first runs `npm run tor:fetch` for its platform, verifies the
pinned Tor Expert Bundle checksum and stages it under `resources/tor/`. Use
`npm run tor:fetch:all` to stage every platform for inspection.

Builds are unsigned: the macOS app is ad-hoc signed but not notarized, and the Windows
installer has no Authenticode signature, so both show the usual "unidentified developer"
or SmartScreen prompts. The Flatpak bundle declares the flathub
`org.electronjs.Electron2.BaseApp//26.08` runtime.

---

## Known limitations (v0.1)

- **Absolute-path subresources** (`/style.css`) are attributed to the page's service via
  the `Referer` header, falling back to the active service for that npub. A page-authored
  cross-service link must use the explicit `/_/<service>/…` form; root-relative links
  stay inside the current service.
- **Cookies** are stored per `ncc://<npub>` origin, shared by all services of that
  identity. `Set-Cookie` headers carrying a `Domain=` attribute from the endpoint are
  dropped by Chromium.
- **Pins are keyed by hostname, not host:port** — Chromium's verify proc does not expose
  the port. Two HTTPS services on the same IP with different certificates can collide;
  give each its own address for now.
- **Normal/private onion mode does not proxy relay lookups.** A full Tor tab routes NCC
  relay queries through Tor, but onion pages opened from a normal or private tab still
  query relays directly, so relays can see the IP and npub. **NIP-46 relay traffic is
  direct in every mode**; the Tor-tab approval sheet warns about this. Tor pages also
  share one SOCKS port, so there is no Tor Browser-style per-site stream isolation.
- **No bridges or pluggable transports yet.** The bundled Tor uses the public Tor
  network; the Expert Bundle's pluggable transports are not shipped. Tor updates are
  security updates and must be bumped in `scripts/tor-version.json`.
- **Strict Tor mode blocks clearnet assets.** A page that mixes onion content with a
  clearnet CDN, font service or WebSocket will lose those requests. Load it without Tor
  if that trade-off is unacceptable.
- **`ws`/`wss`-only endpoints are not pages.** They are recognised by the resolver but
  cannot be rendered; `.onion` pages are now supported through Tor.
- **NIP-07 approvals use an in-app sheet.** "Always allow" is per
  `ncc://<npub>/<service>` (or per web origin). A compromised service on a trusted origin
  can sign anything, so revoke trust when a service changes hands. With a NIP-46 signer
  the device also confirms each signature.
- **NIP-46 coverage depends on the signer.** Private locators need `nip44_decrypt`, and
  some signers only implement signing. Without `safeStorage` the session is not persisted
  and must be reconnected after a restart.
- **NCC-02 attestations and revocations are not evaluated.** Anchoring checks the
  service record, its `exp`, its `u`/`k`, and conflicts with NCC-05. Third-party
  `kind 30060` attestations and `kind 30061` revocations need a local trust policy before
  they can change a decision.
- **The publisher signs through NIP-07 only.** It is a static web app and never handles
  an `nsec`; in Nostr Navigator the built-in provider can delegate to a local key or NIP-46
  signer. Keep the publisher app separate from any service content.
- **No extension support.** Chrome extensions cannot inject into `ncc://` pages (content
  script match patterns exclude custom schemes) and Electron cannot install Web Store
  extensions. The inbuilt provider is the supported path.
- **Session restore stores addresses only** — no scroll position, form state or POST
  results. Bookmarks and sessions are local to this profile and are not synced over
  Nostr.
- **The title bar is app-drawn.** The window is frameless on every platform, so window
  controls and dragging are part of the chrome rather than the OS theme.
- **Installers are unsigned.** macOS builds are ad-hoc signed only, Windows builds have
  no Authenticode certificate, and there is no auto-update channel yet. Signed builds and
  updates need maintainer certificates and a publishing key.
- **HTTPS policy is not HSTS.** “Prefer HTTPS” and “HTTPS only” apply to navigation and
  NCC endpoint selection; a page can still request plaintext subresources that Chromium
  does not already block as mixed content. HTTP exceptions are local to this profile.
- **Clearnet pages** load directly, with normal Chromium error handling.

---

## License

MIT
