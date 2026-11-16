# Android build

Status: **alpha**. Published to Zapstore as `Nostr Navigator (alpha)` for testing.
The shell builds and signs in CI, the NCC proxy serves live records and a content
WebView renders them; there is no identity, no signer behind the NIP-07 routes, no
tabs and no real chrome yet. Not a daily driver.

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

Android's resolver does not map `*.localhost` to loopback (`net::ERR_NAME_NOT_RESOLVED`),
so the content surface intercepts those requests in `shouldInterceptRequest` and
replays them against `127.0.0.1:<port>` with the vhost in `x-ncc-vhost`. The document
URL — and therefore the origin, cookies, storage and service-worker scope — stays the
vhost, so interception preserves the origin model rather than bypassing it.

Three gaps come with interception, all because the WebView hands over a request
without its body: submitted form bodies are dropped, only the last `Set-Cookie`
survives, and service-worker/WebSocket traffic is not intercepted.

`ncc://<npub>/` asks for the `addr` service, and the resolver's `d`-tag ladder only
ever falls back *to* `addr`, never from it. An identity that publishes `web` and
nothing else would therefore be unreachable at its bare address, on every shell. The
proxy answers that case from the identity's other records: it follows the only
page-capable service if there is exactly one, otherwise it renders a chooser marking
the records that cannot carry a page (relay, manager).

### NIP-07

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
- [ ] Real chrome strip above the content surface (the surface covers the shell
      today; it should sit below a 56 dp bar).
- [ ] Per-tab lifecycle and tab thumbnails.
- [ ] File chooser and download handling in the content view.
- [ ] `*.localhost` resolution, secure context, `Secure` cookie behaviour — **the
      go/no-go test**. If `Secure` cookies fail, add a TLS listener and accept its
      own certificate through `onReceivedSslError`.
- [x] NIP-07 injection: shim first in `<head>`, CSP nonce, same-origin signer route
      scoped to `npub/service`.
- [ ] The signer behind those routes: identity storage, approvals, NIP-46.
- [ ] NIP-07 inside iframes (`sec-fetch-dest: iframe`) is deliberately not injected;
      revisit if a real service needs it.
- [ ] Emulator run of the built APK.

## What does not carry over

- **Extensions (MV3).** No extension API and no background pages. Cut, not deferred.
- **Per-tab sessions.** One WebView profile per process. "Private" becomes
  clear-on-exit, which is weaker and must say so in the UI.
- **Per-tab Tor.** `ProxyController` is app-wide. Tor is either the whole app (via
  `arti`) or absent.
- **TLS pin enforcement in the WebView.** Full pin honesty comes from the Rust proxy;
  a WebView-only path can accept a pinned self-signed cert but cannot reject a
  publicly-valid certificate that fails the pin.
- **`ncc-ext://`, window controls, zoom, devtools, keyboard accelerators.** Desktop
  only.
- **Automation MCP.** Loopback is unreachable off-device; `adb reverse` only. Worth
  reviving later as the debug harness, not as a user feature.
