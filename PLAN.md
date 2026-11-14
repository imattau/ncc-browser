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
| D2 | **v0.1 targets public NCC-05 records.** Encrypted (self / targeted / wrapped) records are supported behind an optional signer, but the browser ships without holding an `nsec`. | NIP-44 decryption requires the *reader's* conversation key. Shipping a browser that demands your private key to open a page is a non-starter. Encrypted support arrives with NIP-46. |
| D3 | **Own resolver on `nostr-tools`**, not `ncc-05-js` as a runtime dependency. | Verified: `ncc-05-js@1.2.0` has no `dist/`, queries `30058` with no `#d` filter, then returns the author's single freshest event across all `d` tags (`src/index.ts:393-458`). With >1 service per `npub`, older services become unresolvable. It also decrypts only the newest candidate and returns expired payloads when `strict:false`. All three are fatal for a browser. We keep its payload model and fix the lookup. |
| D4 | **Clean URLs, proxy every request.** `ncc://<npub>/<service>/…`; the handler resolves and forwards *all* requests, not just top-level documents. | Subresources re-enter the handler, so they work without CORS, without mixed-content blocking, and with pinning applied to every request. Originating page stays on a synthetic origin, so the raw `ip:port` is never exposed to page JS. |
| D5 | **`k` pinning from day one.** Content session gets `setCertificateVerifyProc`; expected SPKI comes from the locator's `k`. | NCC-02/NCC-06 define `k` as `base64url(sha256(SPKI DER))`, DANE-style, explicitly permitting self-signed certs. `ncc-06-js` only compares *declared* metadata — it never touches the wire. Electron can enforce the real thing in ~40 lines. |
| D6 | **v0.1 resolves unanchored NCC-05**; NCC-02 anchoring is M4. | Requiring a `30059` record would exclude the simplest publishers. We still surface `k` when the locator carries it and apply it. |
| D7 | **UI stack mirrors MKStack** (React 19 + Vite + TS + Tailwind 4 + shadcn-style components). | MKStack is a *web app* template — it cannot be a browser (no custom scheme, no CORS bypass, no SPKI pinning, no navigation control). Its value to this project is the UI/stack and, later, the M4 publisher app, which is a perfect MKStack job (NIP-07 publish flow). |
| D8 | **Inbuilt NIP-07 signer, not extensions.** | Extension content scripts only match `http/https/file/ftp`, so a nos2x/Alby-style signer cannot inject into `ncc://` pages at all. Electron also cannot install Web Store extensions and its MV3 support is partial. The signer therefore lives in the main process and is exposed through a dedicated content preload. |

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
ncc://<npub>/<service>/<path…>?<query>
```

- `<npub>` — bech32 `npub1…` (hex accepted too). This is the trust anchor.
- `<service>` — the `d` tag namespace. Omitted → `addr`.
- `<path…>` — forwarded verbatim to the resolved endpoint.

Accepted input in the address bar:

| Input | Interpreted as |
|---|---|
| `ncc://npub1…/web/docs` | `npub1…`, service `web`, path `/docs` |
| `ncc:npub1…/web` | same (scheme slashes normalised) |
| `npub1…/web` | same |
| `npub1…` | `ncc://npub1…/` → service `addr` |
| `http(s)://…` | loaded directly in the content view (clearnet escape hatch) |

### Routing rule inside the handler

The handler must decide, for every request, which service the path belongs to:

1. Path starts with `/_/` → explicit: `/_/<service>/<rest>`.
2. Otherwise, if a service is active for that `npub` → `service = active`, `rest = path`.
3. Otherwise → first segment *is* the service.

`navigate()` always sets the active service before loading, so user-initiated addresses
are unambiguous. Page-initiated absolute paths (`/style.css`) fall back to the active
service, which is what a proxy should do. Service roots are 302'd to a trailing slash so
relative URLs resolve inside the service namespace.

**Known limitation (documented, not hidden):** with more than one tab on the same
`npub`, the active-service map is ambiguous. v0.1 ships one content view; multi-tab
adds a per-view session key to the synthetic origin (`ncc://<npub>/_/s/<session>/…`).

### Redirects

`Location` headers pointing at a resolved endpoint are rewritten back into
`ncc://<npub>/<service>/<path>`, including `http→https` upgrades, so the renderer never
sees a raw `ip:port`.

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
  Settings can revoke. NIP-46 remote signing is M4.
- **Signer surface:** `window.nostr` is injected into top-level page frames only, never
  into subframes or the trusted chrome. The IPC handler derives the caller's origin from
  the main frame, so a page cannot claim another identity. Events are validated and
  bounded (kind, tag shape, 15-minute clock skew, 1 MB content) before signing.
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
  downloads, and the inbuilt NIP-07 signer with per-service approvals.
- **M4 — Publisher:** separate MKStack app (`stacks mkstack`) that publishes a `30058`
  for a local port via NIP-07, plus NCC-02 anchoring/`k` trust UI in the browser.
- **M5 — Polish:** tabs, bookmarks, session restore, custom titlebar.

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
- **Manual:** sidecar publisher on machine A → `ncc://<npub>/<service>` on machine B;
  self-signed HTTPS with matching `k`; mismatched `k`; `http` endpoint; dead endpoint.
