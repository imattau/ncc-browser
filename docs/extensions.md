# Extensions

Nostr Navigator runs Manifest V3-shaped extensions on both ordinary web pages and
`ncc://` pages. Chromium's own content-script engine cannot inject into a custom
scheme, so the browser ships its own host: the same manifest and a supported subset of
`chrome.*`, plus NCC-native `ncc.*` APIs.

## Install

- **Settings → Extensions → Install package** accepts a `.zip`/`.nccx` package.
- **Load unpacked** requires developer mode and accepts a folder containing
  `manifest.json`.
- Choosing a package or folder installs nothing. It is copied to a staging folder and
  shown for review: permissions, every website it can act on, and the **Run in private
  tabs** choice. Approving installs the reviewed copy, even if the source has changed
  since. Cancelling, leaving the page or restarting discards it.
- Installing again from the same path replaces that extension and keeps its saved data.
  The review names the version being replaced and marks new access. A package cannot
  supply its own storage files.
- Installed packages are copied to `userData/extensions/<id>` and loaded from there.
  Removing an extension deletes that directory and its storage files.

The experimental White Noise Companion is shipped as a separate `.nccx` asset on
version releases. Install it from **Settings → Extensions → Install package**; it is
not installed or enabled automatically.

- **Install from Nostr** accepts a signed release as `npub1…/name` or an `nevent`
  link. The browser checks the signatures, file hash and revocations before the review,
  which shows the publisher key. **Check for updates** on a signed install looks for a
  newer version and for a revocation. Nothing is checked in the background. A signature
  shows who published an extension, not that it is safe.

Local packages and folders are unsigned. The review and the settings page show where the
package came from; only install code you trust. See
[extension-store-design.md](extension-store-design.md) for the signed distribution plan.

`NCC_EXTENSION_DIR` is a development helper that installs its folder without a review.

## Manifest

```json
{
  "manifest_version": 3,
  "name": "Hello NCC",
  "version": "1.0.0",
  "description": "Example",
  "permissions": ["storage", "tabs", "nostr:pubkey", "nostr:sign"],
  "host_permissions": ["https://example.com/*", "ncc://*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://example.com/*", "ncc://*/*"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_title": "Hello NCC",
    "default_popup": "popup.html",
    "default_icon": "icon.svg"
  },
  "options_ui": { "page": "options.html" },
  "icons": { "128": "icon.svg" },
  "ncc": { "min_version": "0.6.0" }
}
```

`ncc` is optional metadata. `manifest_version` must be 3; MV2 manifests are rejected with
a porting error.

Desktop extensions can opt into a browser-owned right side panel with
`"ncc": { "side_panel": "panel.html" }`. The toolbar action toggles that packaged page
in a sandboxed `WebContentsView`; its width can be changed through
`ncc.runtime.setPanelWidth(280..600)` and it can close itself with
`ncc.runtime.closePanel()`. These panel controls are available only to the extension
that currently owns the panel. The panel uses the normal browser session and closes
when a private or Tor tab is selected.

### Match patterns

The normal Chromium grammar is supported for `http`, `https` and the wildcard scheme
`*` (which still means http/https only). NCC adds:

| Pattern | Meaning |
| --- | --- |
| `ncc://*/*` | Every NCC page |
| `ncc://<npub>/*` | Every service for one identity |
| `ncc://*/<service>/*` | One service name for any identity |
| `ncc://<npub>/<service>/*` | One identity and service |

Paths are matched against the URL pathname, which begins with the service segment.

## Content scripts

Content scripts run in a per-extension isolated world. They share the DOM with the page
but have their own JavaScript globals; a page cannot see `chrome`, `ncc`, or the IPC
bridge. Files from one `content_scripts` entry are concatenated in order. Multiple
matching entries run at the earliest requested `run_at`.

- `document_start`, `document_end` and `document_idle` are supported.
- Top frame only in this version; `all_frames` produces an install warning.
- CSS is inserted into the page, like Chromium.
- `chrome.scripting.executeScript` can run packaged files in a permitted tab later.

## Background

A single `background.service_worker` file runs in a hidden sandboxed page, loaded as an
ES module when `"type": "module"` is set. It has DOM, `fetch` and IndexedDB but no Node.
Backgrounds start on demand, receive `runtime.onInstalled`/`onStartup`, and are suspended
after about 60 seconds of inactivity. Pending messages keep them alive.

## Supported APIs

| Namespace | Methods / events |
| --- | --- |
| `chrome.runtime` | `id`, `lastError`, `getURL`, `getManifest`, `getPlatformInfo`, `sendMessage`, `onMessage`, `onInstalled`, `onStartup` |
| `chrome.storage` | `local`, `sync`, `session`, `onChanged` |
| `chrome.tabs` | `query`, `get`, `create`, `update`, `remove`, `sendMessage`, `reload` |
| `chrome.scripting` | `executeScript` with packaged `files` |
| `chrome.action` | `onClicked`; `default_popup` is opened in a popup window |
| `chrome.contextMenus` | `create`, `remove`, `removeAll`, `onClicked` |
| `chrome.notifications` | `create` |
| `chrome.i18n` | `getMessage` (returns an empty string until locale files are wired) |
| `chrome.extension` | `getURL`, `getBackgroundPage`, `lastError` |

`chrome.storage.local` is capped at 10 MB per extension; `sync` at 5 MB and
`session`/`private` at 1 MB. Storage is stored under the installed extension directory,
not in `config.json`. `storage.sync` is a separate local area, not a cross-device sync
service. Extension pages can only `fetch` hosts listed in `host_permissions`; the
protocol handler builds the page CSP from that list.

### Not supported

`webRequest`, `declarativeNetRequest`, `cookies`, `history`, `bookmarks`, `downloads`,
`identity`, `offscreen`, `sidePanel`, DevTools panels, `omnibox`, `commands`, `alarms`,
and `runtime.connect` ports. Calls to unknown APIs fail with an error; the porting report
lists them before install.

## NCC APIs

```js
const pubkey = await ncc.nostr.getPublicKey()
const event = await ncc.nostr.signEvent({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: 'hello'
})
const ciphertext = await ncc.nostr.nip44.encrypt(peer, 'secret')
```

`ncc.nostr` delegates to the active identity, including a NIP-46 remote signer. Signing
and encryption are permission-gated by the manifest (`nostr:sign`, `nostr:nip44`, …) and
then by the normal approval sheet, which shows the extension name. Choosing “Always
allow” trusts the extension origin until the user revokes it in Trusted services.

`ncc.storage.private` is memory-only and is cleared when the last private tab closes. It
is the recommended place for state derived from private pages.

## Private and Tor tabs

- **Private tabs:** extensions run only if the per-extension **Run in private tabs**
  grant is enabled (offered in the install review; off by default for a first signed install and on for a
local one). Extension backgrounds are
  shared between normal and private contexts, so a content script can read private page
  content and send it over the network. Treat this as a deliberate trust decision.
- **Tor tabs:** extensions never run, are not visible through `chrome.tabs`, and never
  receive Tor page URLs. Extension background traffic uses the normal network, not Tor.

## Permissions

The install review shows a plain-language summary derived from the manifest:

- `storage` — store data locally
- `tabs` — read open tab addresses and titles
- `scripting` — run its own scripts on matching pages
- `contextMenus`, `notifications`, `clipboardWrite`
- `nostr:pubkey`, `nostr:sign`, `nostr:nip04`, `nostr:nip44`

Websites come from both `host_permissions` and `content_scripts[].matches`, because
either one lets an extension act on a page. Unknown permissions are ignored and
reported; they do not grant anything.

## Authoring and porting

The SDK lives in [`packages/extension-sdk`](../packages/extension-sdk):

```bash
node packages/extension-sdk/bin/ncc-ext.mjs init ./my-extension
node packages/extension-sdk/bin/ncc-ext.mjs validate ./my-extension
node packages/extension-sdk/bin/ncc-ext.mjs port ./chromium-extension --ncc
node packages/extension-sdk/bin/ncc-ext.mjs pack ./my-extension
```

`port` rewrites `browser_action`/`page_action` → `action`, `options_page` →
`options_ui`, removes unsupported permissions, optionally adds `ncc://*/*`, and writes
`port-report.md` with every `chrome.*` call it cannot back. It keeps the original
manifest as `manifest.chromium.json`.

Most content-script-only extensions work after adding `ncc://*/*`. Extensions that rely
on blocking network rules, cookie/history access, message ports, or Chrome-only UI
surfaces need real changes.

## Security model

- Extension code is trusted; install is explicit and never silent.
- Content scripts live in isolated worlds and get a private bridge the page cannot see.
- Extension pages are served from `ncc-ext://<id>` with `script-src 'self'`, no inline
  script, no eval, and a path-traversal guard.
- Extension pages can only fetch hosts declared in `host_permissions`; the protocol
  handler builds `connect-src` from that list. Content scripts still run with the page's
  network origin, so no host-permission rule can stop an image/beacon exfiltration once
  the extension is trusted.
- Web pages can read only `web_accessible_resources`; other package files are served
  with a same-origin policy and no CORS grant.
- No extension code runs in the trusted chrome renderer.
- Nostr signing rate and consent are controlled by the existing approval broker.
- Uninstall removes the package and its storage.

## Known limitations

- Local packages are unsigned. Signed installs have no auto-update, background revocation
  check or store page yet.
- Top frame only; no iframe or shadow-DOM content-script support.
- `runtime.connect` ports, `alarms`, locale files and `webRequest` are not implemented.
- Private-tab isolation is weaker than Chromium's incognito model because the background
  process is shared and can exfiltrate page content.
