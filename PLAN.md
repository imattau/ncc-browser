# NCC-Browser — Implementation Plan (v0.1)

A desktop browser that resolves services through **NCC-05** (identity-bound service
locators) instead of DNS, using `ncc://<npub>/<service>/<path>`.

This plan is a revision of the original sketch, corrected against the code that
actually exists in this workspace. Every claim below marked *verified* was read from
source, not assumed.

---

## 1. Decisions up front

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Electron**, not Tauri | We need `protocol.handle` for a real custom scheme, `WebContentsView` for out-of-process content, and `setCertificateVerifyProc` for `k` pinning. Tauri gives none of these. |
| D2 | **v0.1 targets public NCC-05 records.** Encrypted (self / targeted / wrapped) records are supported behind an optional signer, but the browser ships without holding an `nsec`. | NIP-44 decryption requires the *reader's* conversation key. Shipping a browser that demands your private key to open a page is a non-starter. Encrypted support works through a local identity or a NIP-46 remote signer. |
| D3 | **Own resolver on `nostr-tools`**, not `ncc-05-js` as a runtime dependency. | Verified: `ncc-05-js@1.2.0` has no `dist/`, queries `30058` with no `#d` filter, then returns the author's single freshest event across all `d` tags (`src/index.ts:393-458`). With >1 service per `npub`, older services become unresolvable. It also decrypts only the newest candidate and returns expired payloads when `strict:false`. All three are fatal for a browser. We keep its payload model and fix the lookup. |
| D4 | **Clean URLs, proxy every request.** `ncc://<npub>/<service>/…`; the handler resolves and forwards *all* requests, not just top-level documents. | Subresources re-enter the handler, so they work without CORS, without mixed-content blocking, and with pinning applied to every request. Originating page stays on a synthetic origin, so the raw `ip:port` is never exposed to page JS. |
| D5 | **`k` pinning from day one.** Content session gets `setCertificateVerifyProc`; expected SPKI comes from the locator's `k`. | NCC-02/NCC-06 define `k` as `base64url(sha256(SPKI DER))`, DANE-style, explicitly permitting self-signed certs. `ncc-06-js` only compares *declared* metadata — it never touches the wire. Electron can enforce the real thing in ~40 lines. |
| D6 | **v0.1 resolves unanchored by default**; NCC-02 anchoring is implemented as an optional trust layer with a required mode. | Requiring a `30059` record would exclude the simplest publishers. Anchors are used when present, `u` can serve as a fallback, and Settings can require a fresh anchor. |
| D7 | **UI stack mirrors MKStack** (React 19 + Vite + TS + Tailwind 4 + shadcn-style components). | MKStack is a *web app* template — it cannot be a browser (no custom scheme, no CORS bypass, no SPKI pinning, no navigation control). Its value to this project is the UI/stack and, later, the M4 publisher app, which is a perfect MKStack job (NIP-07 publish flow). |
| D8 | **Inbuilt NIP-07 signer, not extensions; NIP-46 for remote keys.** | Extension content scripts only match `http/https/file/ftp`, so a nos2x/Alby-style signer cannot inject into `ncc://` pages at all. Electron also cannot install Web Store extensions and its MV3 support is partial. The signer therefore lives in the main process, behind a dedicated content preload, and can delegate to a NIP-46 remote signer (`BunkerURI`/`NConnectSigner`/`NPool` from Nostrify). |

### Why not MKStack as the app shell

MKStack produces a React/Vite/Tailwind/Nostrify SPA deployed to `nostrdeploy`. That is
the right tool for the **publisher** (M4), not for a Chromium shell. The renderer here
is deliberately a thin toolbar with no Nostr logic at all: relay pools, caches and pins
live in the main process next to the protocol handler, because a page load must be
resolvable without an IPC round-trip per subresource.

`src/renderer` follows MKStack's conventions (Tailwind utility styling, small
shadcn-style components in `src/components`, no CSS framework beyond Tailwind) so the
chrome UI can be replaced or generated later without a rewrite.

---

## 2. Verified facts this plan depends on

From `nostr-community-conventions`:

- **Event:** `kind:30058`, parameterised replaceable on `pubkey + kind + d`.
  Payload is NIP-44-encrypted by default, plaintext JSON allowed for public records.
- **Payload:** `{ v, ttl, updated_at, endpoints[], caps?, notes? }`.
  Endpoints are `{ url | uri, priority?, family?, k?, type? }` — the spec says `url`,
  the JS library publishes `uri`, so both must be accepted.
- **Expiry:** earliest of the `expiration` tag and `updated_at + ttl`.
- **Selection:** greatest `created_at`, tie-break lexicographically smallest `id`.
- **Keys:** public records need no key. Self-encrypted needs the author's key,
  targeted needs the recipient's key, wrapped needs the recipient's key. *This is the
  fact that kills the "no nsec required" promise for private locators.*
- **Service naming:** NCC-02 uses `d = serviceId` (`web`). NCC-05 defaults `d = addr`;
  `ncc-sidecar` publishes `d = "<service_id>-locator"` (`src/services/registry.js:62`).
  There is no single answer, so the resolver probes candidates (see §4).
- **`k`:** `base64url(sha256(SPKI DER))` (`ncc-06-js/src/k.js:computeKFromCertPem`),
  verified against the wire certificate, not against metadata.
- **Default relays in `ncc-05-js` are a placeholder** (`'wss://npub1...'`,
  `src/index.ts:274`). Never inherit a library's relay defaults.

---

## 3. URL model

```
display / input   ncc://<npub>/<service>/<path…>?<query>
internal          ncc://<npub>.<service>/<path…>?<query>
```

- `<npub>` — bech32 `npub1…` (hex accepted too). This is the trust anchor.
- `<service>` — the `d` tag namespace. Omitted → `addr`.
- `<path…>` — forwarded verbatim to the resolved endpoint.

The two forms differ in where the service sits, and that difference is the whole
routing model:

- **Display** is what the address bar shows, what history and bookmarks store, and what
  the NIP-07 trust list keys on. It is **input only** for the protocol handler.
- **Internal** is what the content view loads. The service is part of the host, therefore
  part of the **origin**, so every absolute-path subresource (`/assets/app.js`) belongs
  to the service that requested it. There is no active-service map, no Referer
  dependence, and no ambiguity between tabs.
- Storage, cookies, IndexedDB and service workers are therefore **per service**, not per
  npub. 0.11.0 changes this; data stored under the old `ncc://<npub>` origin is not
  carried over (one-time reset).

Any request in the display form is answered with a 302 to the internal form, so links,
bookmarks and typed addresses keep working unchanged.

Accepted input in the address bar:

| Input | Interpreted as |
|---|---|
| `ncc://npub1…/web/docs` | `npub1…`, service `web`, path `/docs` |
| `ncc:npub1…/web` | same (scheme slashes normalised) |
| `npub1…/web` | same |
| `npub1…` | `ncc://npub1…/` → service `addr` |
| `http(s)://…` | loaded directly in the content view (clearnet escape hatch) |

### Service labels in the host

Host-safe service ids (`^[a-z0-9][a-z0-9-]{0,40}$`, not starting `x-`) are used
verbatim, so the origin stays readable: `ncc://<npub>.ditto`. Anything else — dots,
tildes, uppercase — is base32-encoded under an `x-` prefix. The encoding is reversible
and deterministic, which matters because the label is part of a storage origin and must
survive restarts.

### Redirects

`Location` headers pointing at a resolved endpoint are rewritten back into
`ncc://<npub>/<service>/<path>`, including `http→https` upgrades, so the renderer never
sees a raw `ip:port`.

### One scheme, not `ncc://` plus `nccs://`

There is deliberately no `nccs://` scheme. In the web, `http`/`https` are separate
origins and the split is affordable because the site owner controls both names and the
upgrade is one-way. In NCC the scheme is the stable identity and the endpoint is the
implementation detail: a publisher rotates, adds and reprioritises endpoints (NCC-05)
without the address changing, and Tor selects a different endpoint for the same
address. Encoding transport in the scheme would fork the origin — localStorage,
IndexedDB, service-worker scope, NIP-07 trust, history, bookmarks and inbound links —
on every rotation, and would give one publisher two trust records ("did I trust the
secure one or the plain one?").

Transport security is expressed as record properties and policy instead:

- the padlock and site panel show `pinned-tls` / `tls` / `plaintext` / `onion`;
- plaintext endpoints hit the `ncc-http-ok` interstitial before loading;
- `httpsMode: only` makes a service refuse anything that is not TLS.

If an address-level "require pinned HTTPS" is wanted later, implement `nccs://` as a
**canonicalising alias**: parse it, set the strict policy for that pubkey/service and
redirect to the same `ncc://` origin. Never as a second origin.

### Privileged-scheme registration is a single call

`protocol.registerSchemesAsPrivileged()` does not merge across calls. A second call
leaves the schemes from the first call with `standard` URL parsing (documents still
load) but without `secure`, `supportFetchAPI`, `corsEnabled` or
`allowServiceWorkers`. Registering `ncc` and then `ncc-ext` separately therefore made
every service page a non-secure context: no `crypto.subtle`, no CacheStorage, no
service workers, and `fetch()` to the page's own origin failing — which stalled PWA
apps (Ditto, npanel) mid-boot with open but silent relay sockets. All schemes are now
registered in one call from `src/main/schemes.ts` (0.8.2), and the e2e suite asserts
`isSecureContext`, `crypto.subtle`, CacheStorage and a same-origin fetch on both
`ncc://` and `ncc-ext://` pages.

---

## 4. Resolution algorithm (spec-correct)

Input: `npub`, `service`, `now`.

1. Decode `npub` (NIP-19) → hex. Reject malformed.
2. Candidate `d` tags, in order: `service`, `<service>-locator`, `addr`
   (`addr` only as a last resort, and only if no named record exists).
3. One relay query:
   `{ kinds: [30058], authors: [hex], '#d': candidates, limit: 50 }`
   across configured relays, 8 s timeout. Gossip via NIP-65 is M3.
4. Filter: `verifyEvent`, author match, `d` in candidates.
5. Group by `d`, sort each group by `created_at` desc then `id` asc.
6. For each candidate in order, for each event newest-first (cap 10):
   - decode content: plaintext JSON, or NIP-44 if a signer is configured;
   - undecryptable → remember `undecryptable`, continue to next event;
   - invalid payload (`v`, `ttl > 0`, numeric `updated_at`, `endpoints[]`) → skip;
   - expired → remember `expired`, continue;
   - first valid + fresh record wins.
7. Failure precedence: `undecryptable` > `expired` > `no-record`.
8. Normalise endpoints: `url || uri`, scheme from `type`/`protocol`, drop non-web
   transports (ws/wss/tcp/udp/onion are recorded but not fetchable in v0.1),
   `priority` default **1000** (not 0 — the JS helper's default breaks the ordering),
   dedupe by URL, sort by priority then family (`ipv6`, `ipv4`, `unknown`).
9. Cache the record until `expiry - 5 s`; negative results cached 15 s. In-flight
   resolutions are deduped by `(npub, service)`.

The handler then tries endpoints in order; a network failure moves to the next
endpoint without invalidating the record (NCC-05 §7).

### Distinct failure states (each gets its own page)

`invalid-address` · `no-record` · `expired` · `undecryptable` · `invalid-payload` ·
`no-endpoint` · `relay-error` · `timeout` · `endpoint-unreachable`

---

## 5. Security model

- **Trust anchor:** the `npub` signature over the locator, plus TTL freshness. Relay
  selection never affects validity.
- **Transport:** if the endpoint is `https` and carries `k`, the content session pins
  the SPKI. Match → accept, even for a self-signed cert. Mismatch → hard failure
  (`k-mismatch`), never a fallback. Chromium reports a refused certificate as a generic
  `net::ERR_FAILED`, so the verify proc records the reason and the handler consumes it.
  Pins are keyed by hostname because the verify proc does not expose the port.
- **No `k`:** Chromium's default verification applies. Self-signed certs fail, and the
  toolbar shows `unverified TLS`.
- **`http://` endpoint:** integrity is only whatever the locator signature implies
  about *location*, not content. Toolbar shows `plaintext`; this is surfaced, not
  silently downgraded.
- **Key storage:** the secret key never leaves the main process. It is encrypted with
  Electron `safeStorage` when an OS keychain exists, otherwise held in memory for the
  session and labelled as such. Pages reach it only through NIP-07 IPC, with a native
  approval per `ncc://<npub>/<service>` (or web origin) and an "always allow" list that
  Settings can revoke. A NIP-46 session stores only an encrypted client key; the identity
  key stays on the remote device, and targeted locators are decrypted with the signer's
  `nip44_decrypt`.
- **Signer surface:** `window.nostr` is injected into top-level page frames only, never
  into subframes or the trusted chrome. The IPC handler derives the caller's origin from
  the main frame, so a page cannot claim another identity. Events are validated and
  bounded (kind, tag shape, 15-minute clock skew, 1 MB content) before signing.
  Approvals are an in-app sheet rendered by the chrome renderer: all content views are
  hidden while it is open, so the page cannot cover or spoof the prompt. A toolbar key
  icon shows the active identity and pending requests.
- **Approval queue and grants (0.9.0):** prompts are queued per origin, so one page
  cannot stack sheets and a pending prompt for one site does not hold up another.
  Concurrent identical requests share a single prompt. Two calls repeat on every page
  load and are granted to the origin for the session once approved — reading the public
  key and NIP-42 relay authentication (kind 22242). Everything that signs or decrypts
  content still asks, unless the origin is persistently trusted. A refusal suppresses
  re-prompting for the same request for 30 s. Pending requests are replayed to the
  chrome renderer on mount, so a request raised while content is still loading cannot
  sit invisible until its timeout. The padlock's site panel shows and toggles trust for
  the current origin alongside Settings → Signer permissions. Session grants are scoped
  to the current identity; persistent trust is origin-only — see §11.
- **Renderer isolation:** content view uses `sandbox: true`, `contextIsolation: true`,
  no Node, its own `persist:ncc-content` partition. The chrome UI never shares a
  session or origin with remote content.
- **Relay privacy:** relays learn which `npub` you query. Relay list is user-editable
  and persisted.

---

## 6. Process architecture

```
main
  config.ts        relay list, persisted JSON in userData
  ncc/locator.ts   pure: candidates, payload validation, endpoint normalisation
  ncc/resolver.ts  relay query, selection, decrypt, cache, dedupe
  resolver.ts      service-level resolve() -> ordered endpoints
  pins.ts          k store + setCertificateVerifyProc + spkiFingerprint
  protocol.ts      ses.protocol.handle('ncc') — resolve, proxy, rewrite, error pages
  error-page.ts    distinct HTML failure screens
  window.ts        BrowserWindow (chrome) + WebContentsView (content)
  ipc.ts           navigate / history / config / state
preload            contextBridge -> window.ncc
renderer           React toolbar, address bar, security badge, relay settings
shared             ncc-url parser, types, error codes (no Node imports)
```

`nostr-tools` is bundled into the main chunk (not externalised) because the main build
is CJS and the package is ESM-only.

---

## 7. Milestones

- **M0 — Resolver spike** ✅ this commit: pure locator logic + relay query, fixture
  tests with signed events, optional signer path. Success = "given an npub and service,
  return a fetchable endpoint URL or a typed failure".
- **M1 — First render** ✅ this commit: privileged `ncc` scheme, proxy-all handler,
  `WebContentsView`, SPKI pinning, trailing-slash + redirect rewriting.
- **M2 — Browser chrome** ✅ this commit: address bar, back/forward/reload, loading and
  security state, distinct error pages, relay settings persisted to disk.
- **M3 — Robustness:** ✅ NIP-65 gossip, tabs with referrer-scoped routing, endpoint
  cooldowns, the persistent locator cache, `ncc://` link interception, sanitised
  downloads, and the inbuilt NIP-07 signer (local key + NIP-46 remote signing) with
  per-service approvals.
- **M3.5 — Chrome polish:** ✅ no application menu bar; a hamburger menu with every
  command; shortcuts routed in main via `before-input-event` (work while the page is
  focused); native context menus for links, images and editable fields; window title
  follows the active tab; blank tabs show the welcome page.
- **M4 — Publisher:** ✅ separate MKStack-style app in `publisher/`: NIP-07 signer,
  local host/port endpoints, public or NIP-44-encrypted `kind 30058` locators, optional
  `kind 30059` NCC-02 anchors, relay status and an `ncc://` address. Browser side: NCC-02
  anchoring with `u` fallback, comparable-`k` application, conflict refusal, a trust
  panel, and a required-anchoring setting.
- **M5 — Polish:** ✅ custom frameless title bar; tab favicons, audio/mute indicator,
  drag reordering, overflow menu and tab context menu; downloads manager with progress,
  cancel and reveal; per-tab history panel and back/forward jump lists; local bookmarks;
  session restore (tabs + window geometry); settings moved from a modal to a full page;
  focus trapping for dialogs and popovers.
- **M6 — Packaging:** ✅ electron-builder targets for Linux (deb, rpm, flatpak), macOS
  (dmg + zip, x64 and arm64, ad-hoc signed) and Windows (NSIS); a tag-driven GitHub
  Actions release workflow that verifies, builds on three runners, publishes the
  artifacts and writes `SHA256SUMS.txt`. Signing certificates and auto-update are still
  outstanding.
- **M7 — Tor and onion services:** ✅ bundled Tor Expert Bundle per platform with a
  local-proxy fallback; transport-aware endpoint selection; an onion-only PAC for
  `*.onion`; the Settings preference and per-service address-bar toggle; strict blocking
  of clearnet subresources and redirects from Tor pages; `tor-unavailable` and
  `onion-only` failure states; unit and fake-SOCKS5 end-to-end coverage. Relay traffic,
  bridges/pluggable transports and per-site stream isolation remain outstanding.
- **M8 — Private and Tor tabs:** ✅ one shared in-memory private session, a separate
  full-Tor session with a fixed SOCKS proxy, Tor-routed NCC relay queries, WebRTC leak
  protection, session-only NIP-07 permissions, private/Tor download metadata, tab
  indicators/commands, and session-restore exclusion.
- **M9 — Security policy:** ✅ Off/Prefer/HTTPS-only modes, published-HTTPS endpoint
  preference, loopback and onion exemptions, a persistent HTTP warning banner, optional
  clearnet and NCC HTTP interstitials, and persisted/session HTTP exceptions.
- **M10 — Address bar and search:** ✅ local classifier for `ncc://`/npub, clearnet hosts,
  loopback, onion and search text; DuckDuckGo/Brave/Startpage/Google/Bing/SearXNG/custom
  engines with onion search in Tor tabs; bookmark, history, open-tab and NCC-service
  suggestions with keyboard navigation and Tab completion; persisted normal-tab history
  that excludes private/Tor sessions; private-key refusal. Live engine suggestions are
  deliberately out of scope.
- **M11 — Relay identities:** ✅ relay entries can be `ncc://<npub>/<service>` in Settings
  and in NIP-46 bunker URLs; NCC-05 relay-mode endpoint selection (`ws`/`wss`, onion
  routing, cleartext restrictions); SPKI `k` enforcement on relay sockets keyed by
  `host:port`; automatic re-resolution with jitter before expiry; persisted locator
  metadata for bunker sessions. Editing a connected bunker's relay list remains
  outstanding.
- **M12 — Appearance:** ✅ Settings → Appearance with System/Light/Dark driven by
  `nativeTheme`; text-only sizing (Small–Extra large); compact density via the Tailwind
  spacing scale; Blue/Violet/Green/Amber accents with `light-dark()` contrast pairs; and
  reduced motion. All chrome colours moved to semantic tokens, and the error/HTTP-warning
  pages plus the native window background follow the theme. Changes apply immediately and
  persist in `config.json`.
- **M13 — Password manager:** ✅ Settings → Passwords and a toolbar popover backed by one
  NIP-78 kind `30078` event whose content is NIP-44 encrypted to the active identity.
  Session unlock and auto-lock, exact-origin `https`/`ncc` matching, isolated-world
  login-form fill and save-on-submit capture, TOTP display/copy, password generation,
  CSV import/export plus encrypted vault export, NIP-65 write relays with an optional
  dedicated vault relay, ciphertext-only cache, and relay sync with offline retry.
  Private tabs are disabled; Tor tabs fill but never save.
- **M14 — Extension host:** ✅ Settings → Extensions plus toolbar actions for
  Manifest V3-shaped packages with a supported `chrome.*` subset (`runtime`, `storage`,
  `tabs`, `scripting`, `action`, `contextMenus`, `notifications`, `i18n`), per-extension
  isolated worlds, a suspendable hidden background page, `ncc-ext://` popups/options,
  and NCC match patterns so content scripts run on `ncc://` as well as web pages.
  Adds `ncc.nostr` signing/encryption behind the existing approval broker, ephemeral
  `ncc.storage.private`, folder/`.nccx` install with a dependency-free ZIP reader,
  private-tab grants, a hard Tor exclusion, and an `ncc-ext port` CLI that rewrites
  Chromium manifests and reports unsupported APIs.
- **M15 — Cookies, cache and site data:** ✅ Padlock → **Cookies and site data** clears
  cookies plus `localStorage`, IndexedDB, CacheStorage and service workers for the active
  site, with an opt-in **Forget trust decisions** that also drops the HTTP exception,
  NIP-07 permission and never-save rule. NCC storage is keyed by identity; server cookies
  are cleared on the endpoint host that actually holds them. Settings → Security gains a
  **Cache** card with per-session sizes and a session-wide clear.
- **M16 — Locator freshness:** ✅ The on-disk locator cache is now a hint instead of an
  authority: entries carry `validatedAt`, are trusted for 60 s without a relay query, and
  are served stale-while-revalidate after that. A dead endpoint invalidates the record
  and retries resolution once. NCC-02 `u` fallbacks expire after 5 minutes, anchored mode
  re-checks the anchor `exp` on cached records, and the padlock shows the record's `d`
  tag, age, expiry, source and a **Re-resolve** action. Clear cache and force reload drop
  resolved locators too.

---

## 8. Upstream fixes worth filing on `nostr-community-conventions`

These are bugs in the reference implementation, found while building this:

1. `ncc-05-js` `fetchFreshestRecord` must pass `'#d': [identifier]` instead of selecting
   the newest event for the author and discarding mismatches.
2. `buildPayloadRecord` failures (undecryptable, malformed) should fall through to the
   next candidate instead of terminating resolution.
3. `NCC05Resolver` default relays contain a literal `wss://npub1...` placeholder.
4. `ncc-06-js` `defaultResolveLocator` ignores `locatorId` (calls `resolveLatest`), so
   the NCC-05 `d` tag is silently unaddressable.
5. `ncc-06-js` `normalizeEndpoint` defaults `priority` to `0`; NCC-05 §5.4 says `1000`.
6. `ncc-06-js` treats scheme-less `uri` values as `ws`, which then fails
   `allowedProtocols: ['http','https']` and silently drops valid endpoints.
7. `ncc-05-js` returns expired payloads under `strict:false`, which contradicts the
   "MUST NOT be used" rule in §7 and makes expiry indistinguishable from success.

---

## 9. Test plan

- **Pure:** URL parsing (all accepted forms, malformed npub, paths with query/hash),
  candidate ordering, payload validation, expiry precedence, endpoint normalisation
  (scheme-less `uri`, `uri` vs `url`, `type: tcp`, priority ties, dedupe).
- **Resolver:** signed fixture events over an injected query function — public record,
  `-locator` fallback, `addr` fallback, expired, undecryptable-then-public, newest-wins,
  tie-break by id, cache refresh.
- **Tor:** pure transport selection (direct/onion/onion-only), SOCKS5 and PAC
  validation, Tor manager bootstrap/fallback with an injected process, and a fake-SOCKS5
  end-to-end path covering the onion toggle, automatic preference, strict clearnet
  blocking, direct onion URLs, `onion-only` and `tor-unavailable`.
- **Private/Tor tabs:** cookie isolation and clearing on last close, session-restore
  exclusion, ephemeral NIP-07 permissions, full-Tor page/endpoint/relay routing through a
  fake SOCKS proxy, and WebRTC policy.
- **Security:** HTTPS upgrade decisions, loopback/onion exemptions, published HTTPS
  endpoint ordering, banner/interstitial rendering, NCC warning tokens, persisted vs
  session HTTP exceptions.
- **Address bar:** input classification (npub/hex/`ncc:`, domains and ports, loopback,
  IP literals, onion, search phrases, unknown schemes, private keys), search template
  validation and SearXNG expansion, onion substitution, suggestion ranking/merging and
  per-tab-kind privacy, history retention/caps, and end-to-end typing, arrow-key
  selection, Tab completion, search and history privacy.
- **Manual:** sidecar publisher on machine A → `ncc://<npub>/<service>` on machine B;
  self-signed HTTPS with matching `k`; mismatched `k`; `http` endpoint; dead endpoint;
  bundled Tor bootstrap in the packaged deb/Flatpak.

---

## 10. Future work: Web-page passkeys (QR / hybrid)

**Status:** researched, not implemented. Scrapped for now because the phone/QR flow
requires an Electron change, not an app change.

**Goal.** A site loaded over HTTPS calls `navigator.credentials.get()` and the browser
offers "use your phone" with a QR, exactly as Chrome/Edge do. This is for clearnet
`https://` pages only. `ncc://` pages cannot participate: an RP ID must be a registrable
domain, so passkeys are incompatible with a DNS-free origin.

### What works and what does not (Electron 45.3.2 / Chromium 156)

- **No hybrid transport.** `ElectronAuthenticatorRequestClientDelegate` does not override
  `ConfigureDiscoveries`, so `FidoDiscoveryFactory::set_cable_data` is never called and
  Chromium never generates a `FIDO:/` QR. The caBLE code is compiled in; only the
  embedder wiring is missing.
- **No account picker.** Electron emits `select-webauthn-account` when a discoverable
  credential needs choosing, but ncc-browser registers no listener. With no listener
  Chromium cancels the request with `NotAllowedError`, so passkey sign-in fails even when
  an authenticator is present.
- **Linux** has no platform authenticator. Only USB FIDO2 keys; Electron has no PIN prompt
  and no hybrid UI. The Flatpak exposes no USB devices (`finishArgs` only has
  `--device=dri`).
- **macOS** Touch ID requires `app.configureWebAuthn({ touchID })`, a signed app and a
  keychain-access-group entitlement. Apple platform passkeys require an Associated
  Domains entry + AASA per relying party, which a browser cannot provide for arbitrary
  sites, and they ignore PRF.
- **Windows** delegates to the Windows WebAuthn API, whose system dialog may already show
  "Use another device"; this is unverified.
- Third-party passkey providers (1Password, Bitwarden, KeePassXC) are unavailable because
  Electron cannot run their browser extensions.
- Phone/QR is tracked upstream in
  [electron/electron#24573](https://github.com/electron/electron/issues/24573); still
  missing in Electron 45.

### Patch shape, when picked up

All of this lives in `shell/browser/webauthn/`, so no Chromium patch is needed:

1. Override `ConfigureDiscoveries(...)` on
   `ElectronAuthenticatorRequestClientDelegate`. It receives the request type and a
   `device::FidoDiscoveryFactory*`.
2. Generate `std::array<uint8_t, device::cablev2::kQRKeySize>` with `crypto::RandBytes`,
   call `factory->set_cable_data(request_type, key)`, and compute the QR string with
   `device::cablev2::qr::Encode(key, request_type)`.
3. Set a network context factory from the requesting tab's browser context
   (`GetDefaultStoragePartition()->GetNetworkContext()`) so the tunnel follows the tab's
   proxy settings, including Tor.
4. Store the BLE power/permission callbacks that `RegisterActionCallbacks` currently
   discards, and forward `set_cable_event_callback` states (phone connected, ready).
5. Emit session events, chrome-only: `webauthn-hybrid-qr` with
   `{ relyingPartyId, origin, requestType, qrCode, frame }`, and a state/close event.
6. In ncc-browser, render the QR locally in a chrome overlay (no remote QR service), show
   the RP ID and requesting origin, and hide it on completion/close.

Cancellation, PIN entry and the account picker are separate gaps. A tab reload currently
cancels a pending request; a session-level cancel API is needed for a proper Cancel
button.

### Spike plan (not started)

1. Post a design comment on #24573 with the event/API proposal before building.
2. Build Electron v45.3.2 on a remote Linux box (250–300 GB free, 32 GB+ RAM); the local
   machine is too tight on disk and free memory.
3. Patch, then test with `https://webauthn.io` and an Android phone plus an iPhone:
   create a passkey via QR, then authenticate via QR.
4. Verify USB security keys still work and `ncc://` pages still reject WebAuthn.
5. Upstream the patch; until it lands, a fork/patched Electron would have to be shipped
   via `electronDist`/`ELECTRON_OVERRIDE_DIST_PATH`.

### Open risks

- Upstream API review and timing; the issue has been open since 2020.
- Build cost and fork maintenance if upstream is slow.
- BLE availability/permissions inside the Flatpak; QR v2 uses the tunnel, but Chromium
  may still ask for adapter power/permission.
- Privacy: the tunnel server is Google's, as in Chrome.

---

## 11. Future work: identity-scoped signer trust

Persistent NIP-07 trust is keyed by origin alone (`signer-permissions.json` →
`ncc://<npub>/<service>`, or a web origin). Session grants from 0.9.0 are stricter: they
are keyed `identity | origin | tab kind`, so changing identity drops them immediately.

The asymmetry is deliberate but arguable. Trusting a publisher is a judgement about the
service, not the key, and an origin that has been vetted once is usually the same site
under a different account. The counter-argument is that a key change is a fresh consent
boundary: after importing or connecting a different identity, an origin trusted for the
old one can sign as the new one without asking.

Options if this is revisited:

1. **Namespace the file.** Store `<npub>|<origin>` (and web origins the same way), bump
   `version` to 2, and on load either drop v1 entries (re-prompt everything once) or
   attribute them to the identity that was active at migration time. Revoking from the
   site panel or Settings then removes only the current identity's entry, and a
   "revoke everywhere" action is needed to keep the old affordance.
2. **Leave the store alone and make the boundary visible.** Keep origin-scoped trust but
   state the current identity in the sheet (already shown) and in the site panel row, so
   the widening is at least legible. No migration.

Cost is small either way — the store is 100 lines and the file is versioned — but option
1 means every trusted site is re-approved once per identity switch, which is the kind of
friction that trains people to tick "Always allow" without reading. Not scheduled; worth
doing only if identity switching becomes common or a report shows the widening being
abused.

---

## 12. `nsite://` — NIP-5A static sites

Implemented in 0.10.0. A NIP-5A site is a signed manifest plus Blossom blobs, so it
needs no HTTP endpoint: the npub signature and event ordering decide what the site is,
and each file's sha256 decides whether it may be served.

### Address model

```
nsite://<npub>/                 root site (kind 15128)
nsite://<npub>/<d>/             named site (kind 35128, d = <d>)
nsite://<npub>/<d>/<path…>      a file in that named site
nsite://<npub>/<path…>          a file in the root site
```

The first path segment is a named site when it matches the NIP-5A d-tag grammar
`^[a-z0-9-]{1,13}$` and does not end with `-`; anything else is a root-site path. That
is the one ambiguous corner of the scheme: a root-site file or directory whose name is a
valid d tag (`/about`, `/logo`) is read as a named site. Root pages should use paths
with an extension (the common case: `/style.css`, `/about.html`) or live under a named
site. Gateways avoid this by putting root and named sites on different hostnames, which
a single scheme cannot do.

`nsite://npub1…/blog` and `nsite://npub1…/blog/` both mean the named site; the browser
canonicalises to the trailing slash.

The display form is input only. The content view loads the internal form, where the site
id is part of the host — `nsite://<npub>.<d>/…` for a named site and `nsite://<npub>/…`
for the root site — so `/assets/app.js` belongs to the site in the origin. A document
navigation in the display form is 302'd to the internal form; subresources on the bare
npub host always belong to the root site, which is why the redirect is documents only.

A d-like first segment in the display form is resolved as a named site **only if one is
actually published**; otherwise the same address is served as a root-site path. That
makes a root site's own directories (`nsite://npub/armada/`) reachable even when their
name looks like a site id. The remaining ambiguity, documented rather than guessed, is a
name that exists as *both* a named site and a root directory: the named site wins.

### Resolution

1. Root: `{ kinds: [15128], authors: [hex], limit: 5 }`. Named:
   `{ kinds: [35128], authors: [hex], '#d': [d], limit: 5 }`, through the same pool and
   8 s timeout as NCC, and the Tor pool for Tor tabs.
2. Verify signature, author, kind and `d`; index `path` tags (`/`-absolute, no `..`,
   64-hex hashes); at least one usable path or `manifest-invalid`.
3. Newest `created_at` wins. Manifests are cached in memory for 60 s and confirmed in the
   background after that: a relay hiccup never blanks a working page. Forced reload
   invalidates the manifest for that site.
4. Path resolution: exact match; `/dir/` → `/dir/index.html`; `/dir` → 302 to `/dir/` when
   files exist under it; otherwise `/404.html` with status 404; otherwise `no-file`. No
   SPA fallback.

### Content

Blobs come from `server` tags in the manifest, then the author's kind `10063` list,
max 8 attempts, with per-server failure counts. A blob is read with a 25 MB cap,
hashed, and only served on an exact match; mismatch is `hash-mismatch` and the bytes are
discarded. Verified blobs are cached by hash — in memory (32 MB) and on disk
(`userData/nsite-blobs`, 512 MB LRU) for normal tabs; private and Tor tabs are
memory-only so closing them leaves nothing behind.

Ranges, media streaming and manifest snapshots (kind 5128) are **not** implemented. A
`Range` request gets the whole verified file with 200. Video therefore works only after
a full download.

### Origins and trust

`nsite://<npub>.<d>` (named) and `nsite://<npub>` (root) are secure, standard, privileged
origins registered in the single `registerPrivilegedSchemes()` call, so storage, service
workers and NIP-07 behave as they do on `ncc://`. Each named site gets its own storage
origin, which is what the earlier draft claimed without the mechanism. NIP-07 trust is a
separate record from the same publisher's `ncc://` origin because the content model is
different.

The security state reports `transport: 'nsite'` with the manifest (title, aggregate,
servers, file count, event id, update time). The padlock reads "Nostr site" and the site
panel shows the manifest block instead of transport/anchor blocks.

### Deferred

- `transport: "nsite"` as an NCC-05 endpoint variant (a locator that can fall back from a
  server to the site). Only worth a spec change if the fallback chain is wanted.
- Manifest snapshots (`nsite://v<eventIdB36>`).
- Disk persistence of manifests (they are re-fetched after restart).
- Range support with incremental verification for media.
- Evicting a single site's blobs from the global hash cache on "clear site data"; today
  the whole cache is cleared with the session.
