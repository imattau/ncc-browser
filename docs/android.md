# Android build

Status: **alpha**. Published to Zapstore as `Nostr Navigator (alpha)` for testing.
The shell builds and signs in CI, the NCC proxy serves live records, a content
WebView renders them, and a local identity signs through the NIP-07 routes after an
approval. No tabs, history, bookmarks, downloads or settings yet. Not a daily driver.

## Verified

The `Android` workflow was run end to end on `ubuntu-latest`:

```
platform:    platforms;android-37.2   (resolved from compileSdk = 37)
build-tools: build-tools;37.0.0
ndk:         27.2.12479018
apk:         21 MB, payload lib/arm64-v8a/libncc_navigator_lib.so (proxy + rustls)
signature:   V2 signer, certificate SHA-256 547edf7693c054d753355488f10f991578ab8da22cd6104cc157e5b98816c1f6
build time:  ~10 min cold (Rust dominates), ~1 min for the Gradle half
```

The proxy was then run against a live locator on `wss://relay.primal.net`:

```
$ ncc-proxy --resolve <hex>/web
service   web (d=web-locator, locator-suffix)
endpoint  https://1.43.63.94:8443/ [https ipv4] k=wLnkGhcpexUmHmMMAzQ0CPD6sA2tN2h2SAFoMBdg66A
endpoint  http://e5vexru63….onion/ [http onion]

$ curl -H 'Host: <hex>.web.localhost:47832' http://127.0.0.1:47832/
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
```

That endpoint presents a self-signed certificate, so the successful fetch is also the
proof that `k` pinning works: the certificate was accepted because its SPKI hash
matched the locator, not because a CA signed it.

That fingerprint is the certificate Zapstore's claim will pin. If it ever changes
without an APK Signature Scheme v3 lineage, existing installs cannot update.

Three things that are easy to trip over again:

- `package.json` must keep a `"tauri": "tauri"` script. Tauri's Android Gradle plugin
  shells out to `npm run tauri` while building the Rust library.
- The SDK script probes `platforms;android-<n>.0/.1/.2` before the bare level,
  because Android ships minor API levels now and `platforms;android-37` does not
  exist.
- `android-actions/setup-android@v3` is unusable: it runs `sdkmanager tools`, which
  Google removed.

## Decisions

| Decision | Value | Why |
|---|---|---|
| Shell | Tauri v2 | The core can be a Rust crate (`crates/ncc-core`) that also runs headless in CI, and `arti`/`rustls` keep Tor and pin honesty possible on mobile. |
| Package id | `io.github.imattau.nccbrowser` | Same identity as the desktop bundle; baked into the Zapstore claim, so it is permanent. |
| `minSdkVersion` | 26 | `WebViewAssetLoader`, `PixelCopy` tab thumbnails, and a WebView new enough for every feature the proxy relies on. |
| ABI | `arm64-v8a` only | The Zapstore catalog requires one complete arm64-v8a APK; 32-bit ARM is not supported there. |
| Distribution | Zapstore, published from CI | `zsp publish` runs in the workflow; the keystore never leaves the runner. |
| Signing | `signing.env` keystore | Permanent. Rotation needs an APK Signature Scheme v3 lineage, so back it up. |

## Architecture

Four layers, in the order they are being built:

1. **`crates/ncc-core`** — every rule that must have the same answer on every shell:
   the `ncc://` address model, `d` tag candidates, payload validation, endpoint
   normalisation and selection, transport choice, redirect rewriting. No I/O, no
   runtime. `cargo test -p ncc-core` runs on a plain Linux runner.
2. **`crates/ncc-proxy`** — the socket half: relay queries, NCC-05 resolution with a
   stale-while-revalidate cache, SPKI pinning, upstream fetch and an HTTP server whose
   virtual hosts *are* the NCC namespace. Runs standalone, so it can be exercised
   without a phone:
   ```bash
   cargo run -p ncc-proxy -- --port 47832 --relay wss://relay.primal.net
   cargo run -p ncc-proxy -- --resolve <npub>/web
   curl -H 'Host: <npub>.web.localhost:47832' http://127.0.0.1:47832/
   ```
3. **Tauri shell (`src-tauri`)** — the React chrome, talking to Rust commands behind
   the existing `NccApi` seam. This is the only part that resembles Capacitor.
4. **Kotlin content surface (inside `src-tauri/gen/android`)** — `ContentSurface.kt`
   adds one `android.webkit.WebView` above Tauri's own view and refuses any URL that
   is not an `http(s)` `*.localhost` host. The shell drives it through a
   `@JavascriptInterface` (`NccContent.open/close/back`) that is exposed only to the
   shell's WebView; state comes back as `__nccContent` events (loading, loaded,
   blocked, failed, closed). System back walks the page history first, then closes
   the surface. Tauri does not expose the Android view hierarchy, so this glue is
   Kotlin regardless of shell.

The content WebView never sees `ncc://`. It loads
`http://<npub>.<service>.localhost:<port>/…`; the proxy maps that back onto the
endpoint and rewrites redirects into the same host form. `to_display_url` (already in
`ncc-core`) is what the address bar renders, so the user-facing address is unchanged.

Chromium resolves `*.localhost` to loopback on Android, so the page is loaded straight
from its virtual host and the proxy is reached natively — no interception, no DNS. The
document keeps that origin, and cookies, storage, service workers, request bodies and
multiple `Set-Cookie` headers all behave as they do on any other site.

That was verified on-device: `ditto` and `search` on an identity served from an
IPv4 endpoint rendered in the app before any interception existed. If a future WebView
stops resolving `*.localhost`, the fallback is to intercept in
`shouldInterceptRequest` and replay against `127.0.0.1` with the vhost in a header —
which costs request bodies and multiple `Set-Cookie` headers, so it is not the default.

## NIP-07

Electron gets `window.nostr` from a preload in an isolated world at document start.
Android has no preload, so the proxy rewrites the document on the way through: the
shim is inserted as the first child of `<head>`, before any page script can look for
it.

```
page  window.nostr.*  →  POST /__ncc/nip07/<method>  on its own origin
                             ↓ intercepted before resolution
                          Rust answers (or forwards to the signer)
```

Same-origin HTTP rather than a `JavascriptInterface` on purpose: the service is
derived from the `Host` header instead of anything the page supplies, the signer
stays in Rust, and no privileged object is exposed to page script. Each document
load gets a token that is bound to `npub/service`; a call with a token from another
service is refused.

The trade-off is CSP. A page with `script-src 'self'` would never see an injected
inline script, so the proxy adds a nonce to `script-src` and `'self'` to
`connect-src`, and nothing else. That is a real weakening of the page's own policy,
and it is the price of not having a preload.

The signer itself is not implemented yet: calls answer `501 signer-not-configured`
once the token checks out, which is where identity storage, NIP-46 and approvals plug
in.

Pinning deserves a note because it is the reason the core is Rust: an endpoint that
publishes `k` usually presents a self-signed certificate. The proxy routes those
requests through a client whose verifier accepts a certificate only when its
`base64url(sha256(SPKI))` matches the locator and it is unexpired. A mismatch ends the
request — it never falls through to another endpoint, because that would hide someone
answering with the wrong key.

## Secrets

Five values, all already in `~/.config/nostr-release/signing.env`:

| Secret | Purpose |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Release keystore, base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias |
| `ANDROID_KEY_PASSWORD` | Key password |
| `ZAPSTORE_NSEC` | `SIGN_WITH` for `zsp publish` |

Push them without ever echoing a value:

```bash
scripts/push-release-secrets.sh --repo imattau/ncc-browser
# add --dry-run to see the secret names it would set
```

## One-time Zapstore claim (run this yourself)

`zsp publish` never reads the keystore, but the **claim** does — it signs a NIP-C1
proof that ties the APK signing certificate to the publishing pubkey. That is the one
step an agent must not do, because it needs the keystore and its password.

1. `go install github.com/zapstore/zsp/v2/cmd/zsp@v2.0.1`
2. From the repo root, run `zsp` with no arguments.
3. Choose the local APK source; point it at
   `release/android/ncc-browser-android-arm64.apk` after the first CI build, or any
   signed build of the same certificate.
4. Claim with the pubkey in `ZAPSTORE_NSEC` — the same key already used for the other
   published apps.
5. Commit the `zapstore.yaml` the wizard writes. Keep `release_source` at
   `./release/android/ncc-browser-android-arm64.apk`: CI stages the APK there.
6. Verify with `zsp check`, then publish once by hand to confirm the claim is active.

The claim lasts about two years; renew it from the app page or by running the wizard
within 30 days of expiry.

## Release flow

```bash
node scripts/android-version.mjs      # versionName + monotonic versionCode
git tag android-v0.13.0 && git push origin android-v0.13.0
```

The workflow builds the APK, verifies it is signed and carries `lib/arm64-v8a/`,
uploads it as an artifact and to the GitHub release, then publishes to Zapstore with
`SIGN_WITH` from the secret. `workflow_dispatch` with `publish: true` does the same
from a branch.

Publishing is gated on a repository variable so a tag cannot fail before the claim
exists:

```bash
# after the one-time claim succeeds
gh variable set ZAPSTORE_PUBLISH --repo imattau/ncc-browser --body true
```

Until then, tags build, verify and attach the APK, and skip the publish step.

Tags stay `android-v*` until the Android build is a supported artifact; then fold the
job into `release.yml` so one `v*` tag ships every platform.

## M0 checklist

Device-free (any Linux box with Rust):

- [x] `crates/ncc-core` with the address, locator, transport and routing rules ported
      and unit-tested against the TypeScript cases.
- [x] `crates/ncc-proxy` resolving live locators, pinning `k` endpoints and serving
      them over virtual hosts.
- [ ] A conformance fixture set consumed by both the TS and Rust suites.
- [ ] NIP-44 decryption for encrypted locator payloads (the desktop build has it).
- [ ] A per-service health/fallback record, so a dead endpoint is skipped on the next
      request instead of every request.

Build pipeline:

- [x] `src-tauri` shell with the package id, minSdk 26 and arm64 target.
- [x] `src-tauri/gen/android` generated on a runner and committed.
- [x] Release signing from `keystore.properties`, verified with `apksigner`.
- [x] APK built, verified and attached to a release.
- [x] `mobile/` status page so the shell can be proven on a device.

Still to build:

- [x] Start the proxy from the Tauri app and expose its port to the shell.
- [x] A status page that fetches a live service through a `*.localhost` vhost.
- [x] Kotlin content surface: a WebView limited to `*.localhost`, driven from the
      shell through a `JavascriptInterface`, with back handling and page events.
- [ ] `vite.mobile.config.ts` + an `NccApi` adapter over Tauri commands, replacing
      `mobile/` with the React chrome.
- [x] Chrome strip: a 56 dp bar above the content surface, holding back, the address
      and reload; tapping the address expands the shell over the page to edit it.
- [x] Window insets: the strip and the page are inset for the status bar, the camera
      cutout and the gesture bar.
- [x] Tabs: one WebView per tab, a switcher sheet with captured thumbnails, and the
      toolbar position as a setting (bottom by default).
- [x] `nsite://`: manifest resolution (15128/35128), path matching, sha256-verified
      Blossom blobs and content types from the path extension. Hosts are
      `<npub>.<d>.nsite.localhost` and `<npub>.nsite.localhost` for the root site.
- [x] Link routing: an in-page `ncc://` or `nsite://` link is mapped to its host by
      `GET /__ncc/route` and loaded in place, so pages can link across services.
- [x] Site panel fed by `GET /__ncc/info`: record, d tag, endpoints with pin state,
      Blossom servers and file count — the same record that is serving the page.
- [x] Menu sheet: new tab, reload, bookmark, copy address, close tab, history,
      settings.
- [x] Settings as a list of sections: address bar, relays, identity, signer
      permissions, history, bookmarks, about.
- [x] Identity: the secret is sealed by a key held in the Android keystore
(`IdentityKey.kt`, called from `crates/ncc-identity/src/device.rs` over JNI), so there
is no passphrase to remember. Files written before that are opened once with their
passphrase and rewritten with the device envelope.

`config.json` next to the identity, owned by the proxy: validated on load and on
      write, persisted through a temp file, and read live so a relay change applies to
      the next lookup without a restart.
- [x] Settings that change behaviour, not just persist: gossip (NIP-65 read relays are
      merged into the lookup), HTTPS mode (require/hide cleartext endpoints and Blossom
      servers), and the address-bar search engine.
- [x] Clearnet: `http(s)` pages load in a tab, as they do on the desktop. Only non-web
      schemes (`mailto:`, `tel:`, `intent:`) leave the app, and a tab takes the proxy
      port from the shell instead of reading it off the page URL.
- [x] Signer approvals show a countdown and trusted services can be revoked.
- [x] History and bookmarks, kept in the shell's storage (200 entries).
- [x] Private tabs: a second proxy listener with no cache directory and a key that
      exists only in memory, so no record, manifest, blob or signature is written down.
      The separate port is also a separate origin, so private tabs have their own
      storage. Two limits worth knowing: cookies are scoped by host in Chromium and
      cannot be isolated per tab, and the ephemeral key lasts for the app run rather
      than for the private session.
- [x] Tor tabs: a third listener (`tor_proxy_port`) serves `.onion` sites as
      `<onion>.onion.localhost` and fetches them over SOCKS. The route is the bundled
      `arti` client, or a local daemon such as Orbot when the mode is `local`; both are
      `socks5h`, so the name is resolved inside Tor and never by this device. Documents
      are rewritten to keep every reference on the same listener, a clearnet reference
      becomes a blocked page, and a policy on every response confines scripts and
      subresources to the tab's own origin. `shouldInterceptRequest` refuses anything
      that is not the tab's listener and port, which is the network-level guard the
      desktop gets from `onBeforeRequest`.
      Signing uses that listener's ephemeral key, never the real identity, and its trust
      decisions stay in memory because the listener has no permissions file.
      Limits, deliberately: onion-only (as on the desktop), no WebSockets, and a page
      that builds a URL in JavaScript cannot have that URL rewritten — the policy is
      what stops it from reaching the clearnet.
- [x] Passwords: the desktop vault format, unchanged — one NIP-78 event (kind 30078,
      `d = ncc-browser/passwords/v1`) whose content is NIP-44 encrypted to your own key.
      The cache on disk holds the signed ciphertext, never a plaintext password, so the
      vault opens offline. Unlock is gated on the device credential and the decrypted
      vault is dropped after the configured idle time. In-browser filling only: a native
      hook reports submitted logins, a fill is one-shot and native-initiated, and private
      and Tor tabs have no hook at all.
- [x] Storage: clear cache drops locator records, site manifests, verified blobs in
      memory and on disk, and the WebView page cache.
- [x] A cold load asks for several files at once, so a lookup is gated per site: one
      relay query answers all of them instead of one each. Manifests and locator
      records are written to `<data>/manifests` and `<data>/records` and expire on the
      same clock as their memory copies, so a restart no longer starts from nothing.
- [x] Cleartext warning: when the setting is on and the endpoint is plain HTTP, a page
      explains it and a one-shot token records the exception, so it is asked once.
- [x] Downloads: the content view hands a file to the app, which fetches it through
      `/__ncc/fetch` and saves it wherever the system picker says. No storage
      permission, and downloaded HTML is not shimmed. The name comes from
      `Content-Disposition` when the server sends one, and a list of recent downloads
      (with live progress) is kept in app storage.
- [ ] Per-tab lifecycle and tab thumbnails.
- [ ] File chooser and download handling in the content view.
- [ ] `*.localhost` resolution, secure context, `Secure` cookie behaviour — **the
      go/no-go test**. If `Secure` cookies fail, add a TLS listener and accept its
      own certificate through `onReceivedSslError`.
- [x] NIP-07 injection: shim first in `<head>`, CSP nonce, same-origin signer route
      scoped to `npub/service`.
- [x] The signer behind those routes: encrypted local identity, per-service
      approvals and a prompt in the shell. NIP-46 is still missing.
- [ ] NIP-07 inside iframes (`sec-fetch-dest: iframe`) is deliberately not injected;
      revisit if a real service needs it.
- [ ] Emulator run of the built APK.

## Passwords

The vault is **the same event the desktop build writes**: kind `30078`, `d` tag
`ncc-browser/passwords/v1`, entries merged by id with `updatedAt` winning, and the
whole plaintext NIP-44 encrypted to your own identity. Nothing is translated between
platforms, so the same npub sees the same logins. `crates/ncc-vault` is the shared
validator, merge rule, generator and TOTP implementation, tested against the desktop's
rules — including its two quirks: only `https://` and `ncc://` origins are kept
(`nsite://` would be discarded by the desktop on its next read), and ids are sixteen
hex characters rather than UUIDs.

**Unlock.** The Android key is sealed by the keystore and available without a
passphrase, so "unlock" is a deliberate gate rather than a cryptographic one: the shell
asks Android for the device credential (`KeyguardManager`, no extra library), and only
then calls `vault_unlock`. The decrypted vault lives in Rust memory and is dropped after
`autoLockMinutes` of no activity (default 15; `0` disables it). A device with no lock
set skips the prompt and says so. This is a real barrier against someone holding an
unlocked phone, not against a compromised app process — the identity's key is available
to the app either way.

A **remote signer cannot unlock the vault** on this build: decryption is a NIP-44 round
trip that would need the signer online for every session, and the vault would then be
unavailable for autofill. The limit is reported as "set up a locally stored identity".

**Filling, in the browser only.** There is no `AutofillService` yet, and this is
deliberate: a system service sees only a web domain, cannot tell a private tab from a
normal one, and cannot express `ncc://` origins. Instead:

- Every normal tab gets a small hook after the page finishes loading. It reports a
  login only on a *trusted submit*, the same rule the desktop preload uses.
- The report goes to Kotlin through a `JavascriptInterface` object that is **write-only**:
  it has one method and returns nothing, so a page can offer a capture but cannot read
  a credential. A hostile page can therefore spam save prompts; the user confirms each
  one, captures are deduplicated, and `neverSave` applies.
- Filling is the opposite direction: the user picks an entry, the origin is checked in
  Rust, and Kotlin injects a one-shot script with the values inline. There is no
  page-callable function that returns a password.
- A captured password crosses the shell's command call on its way to Rust (the shell is
  our own bundle, not the page), and the save prompt then holds only the request id.
- Private and Tor tabs never get the hook, and the vault refuses those tab kinds even
  if the shell asks. `http://` pages are refused; `ncc://` pages are allowed (the npub
  authenticates the locator), `nsite://` is refused for the format reason above.

**Syncing.** Reads and publishes go through NIP-42 authenticated relay connections;
writes carry the `d` tag, merge with the newest relay copy first, and a save that no
relay accepted is kept locally with `pending` set until a later sync republishes it.
The relay list is the browser's configured relays, or a dedicated vault relay if one is
set. NIP-65 write-relay discovery is not implemented on this shell, which is why the
setting is a relay URL rather than a toggle.

Known limits: no CSV import/export yet; forms submitted by JavaScript (`form.submit()`)
do not fire a trusted `submit` event and are not captured; clipboard clearing after a
copy is best effort, because Android 10+ restricts background clipboard access; and the
in-page hook is visible to the page, which is the price of `WebView` having no isolated
world.

## Tor

Tor is obtained in one of two ways, chosen in Settings → Tor:

- **Bundled (`auto`, the default).** `arti` is compiled into the app and bootstrapped
  on a background task. State and directory cache live under `<data>/tor`. The status
  reports bootstrap percentage while it starts.
- **A local daemon (`local`).** Only the configured SOCKS proxy is used, which is what
  Orbot provides on `127.0.0.1:9050`. Nothing is bundled into the path; if Orbot is not
  running, a Tor tab says so and the address is not fetched.

Both modes sit behind the same local SOCKS5 listener, bound at startup and named by
`tor_status`. Nothing contacts the Tor network until a Tor tab is opened (or the Tor
panel is viewed): launching the app must not announce itself, and most sessions never
open an onion. The listener stays in place across a settings change, so a tab opened
before the new route was ready only needs a reload. Connections wait while Tor is
starting, and fail immediately once it has failed — "still bootstrapping" and "no Tor"
are different messages rather than the same timeout.

A Tor tab is **onion-only**, matching `TorGuard` in the desktop build. That is a
consequence of the loopback method, not a shortcut: the proxy fetches onion documents
and serves them from a virtual host, so the tab's network access is exactly the traffic
the proxy chose to make. Serving clearnet from it would either need a process-wide
proxy (which would put every other tab on Tor) or a rewriting reverse proxy for
arbitrary sites. Neither is honest, so clearnet links are refused and the page says
why.

Known limits:

- WebSockets inside an onion page are not proxied; the policy's `connect-src 'self'`
  blocks them rather than letting them escape.
- Frames from a *different* onion host are blocked, because each onion is its own
  origin and the policy allows only `'self'`.
- Cookies are scoped by host, as everywhere in Chromium. They are shared with a normal
  tab only if that tab somehow used the same onion vhost, which a normal tab cannot.
- The onion is reached over `http`. There is no CA for `.onion`; Tor encrypts the hops,
  and the last hop is inside the service.

## What does not carry over

- **Extensions (MV3).** No extension API and no background pages. Cut, not deferred.
- **Per-tab sessions.** One WebView profile per process. "Private" becomes
  clear-on-exit, which is weaker and must say so in the UI.
- **Clearnet over Tor, per tab.** `ProxyController` is app-wide, so a clearnet page in
  a Tor tab would need a rewriting reverse proxy for arbitrary sites. Tor tabs are
  onion-only, as they are on the desktop. Putting the whole app behind Tor is still
  possible with Orbot in VPN mode, outside this app.
- **TLS pin enforcement in the WebView.** Full pin honesty comes from the Rust proxy;
  a WebView-only path can accept a pinned self-signed cert but cannot reject a
  publicly-valid certificate that fails the pin.
- **`ncc-ext://`, window controls, zoom, devtools, keyboard accelerators.** Desktop
  only.
- **Automation MCP.** Loopback is unreachable off-device; `adb reverse` only. Worth
  reviving later as the debug harness, not as a user feature.
