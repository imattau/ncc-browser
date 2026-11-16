# Android build

Status: **M0 shell builds and signs in CI**. The Tauri shell installs and reaches
Rust; the content surface and the React chrome are not written yet.

## Verified

The `Android` workflow was run end to end on `ubuntu-latest`:

```
platform:    platforms;android-37.2   (resolved from compileSdk = 37)
build-tools: build-tools;37.0.0
ndk:         27.2.12479018
apk:         11 MB, armeabi payload lib/arm64-v8a/libncc_navigator_lib.so
signature:   V2 signer, certificate SHA-256 547edf7693c054d753355488f10f991578ab8da22cd6104cc157e5b98816c1f6
build time:  ~10 min cold (Rust dominates), ~1 min for the Gradle half
```

That fingerprint is the certificate Zapstore's claim will pin. If it ever changes
without an APK Signature Scheme v3 lineage, existing installs cannot update.

Two things that are easy to trip over again:

- `package.json` must keep a `"tauri": "tauri"` script. Tauri's Android Gradle plugin
  shells out to `npm run tauri` while building the Rust library.
- The SDK script probes `platforms;android-<n>.0/.1/.2` before the bare level,
  because Android ships minor API levels now and `platforms;android-37` does not
  exist.

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

Three layers, in the order they should be built:

1. **`crates/ncc-core`** — every rule that must have the same answer on every shell:
   the `ncc://` address model, `d` tag candidates, payload validation, endpoint
   normalisation and selection, transport choice, redirect rewriting. No I/O, no
   runtime. `cargo test -p ncc-core` runs on a plain Linux runner.
2. **Tauri shell (`src-tauri`)** — the React chrome, talking to Rust commands behind
   the existing `NccApi` seam. This is the only part that resembles Capacitor.
3. **Kotlin content surface (inside `src-tauri/gen/android`)** — one
   `android.webkit.WebView` added to the activity layout under the toolbar strip,
   plus the loopback proxy's TLS exception. Tauri does not expose the view
   hierarchy, so this glue is Kotlin regardless of shell.

The content WebView never sees `ncc://`. It loads
`https://<npub>.<service>.localhost:<port>/…`; the proxy maps that back onto the
endpoint and rewrites redirects into the same host form. `to_display_url` (already in
`ncc-core`) is what the address bar renders, so the user-facing address is unchanged.

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
- [ ] `ncc-core` binary: `ncc-core fetch ncc://<npub>/<service>` resolving through
      relays and printing the document, so the core can be exercised without a phone.
- [ ] A conformance fixture set consumed by both the TS and Rust suites.

Build pipeline:

- [x] `src-tauri` shell with the package id, minSdk 26 and arm64 target.
- [x] `src-tauri/gen/android` generated on a runner and committed.
- [x] Release signing from `keystore.properties`, verified with `apksigner`.
- [x] APK built, verified and attached to a release.
- [x] `mobile/` status page so the shell can be proven on a device.

Still to build:

- [ ] `vite.mobile.config.ts` + an `NccApi` adapter over Tauri commands, replacing
      `mobile/` with the React chrome.
- [ ] Kotlin content WebView under the toolbar, per-tab lifecycle, tab thumbnails.
- [ ] Loopback proxy (`hyper` + `rustls`) and `onReceivedSslError` TLS exception.
- [ ] `*.localhost` resolution, secure context, `Secure` cookie behaviour — **the
      go/no-go test**. If `Secure` cookies fail, switch the vhost to `https://` with
      the proxy's own certificate.
- [ ] NIP-07 injection by rewriting the top document in the proxy, with a per-load
      nonce so a subframe cannot call the bridge.
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
