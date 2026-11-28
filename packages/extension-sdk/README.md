# NCC extension SDK

Types and a zero-dependency CLI for extensions that run in Nostr Navigator.

```bash
node packages/extension-sdk/bin/ncc-ext.mjs init ./my-extension
node packages/extension-sdk/bin/ncc-ext.mjs validate ./my-extension
node packages/extension-sdk/bin/ncc-ext.mjs port ./chromium-extension --ncc
node packages/extension-sdk/bin/ncc-ext.mjs pack ./my-extension
```

`pack` produces a `.nccx` file, which is a ZIP package accepted by **Settings →
Extensions → Install package**.

## What is supported

| Area | APIs |
| --- | --- |
| Content scripts | `matches` (https, http and ncc), `js`, `css`, `run_at` (`document_start`, `document_end`, `document_idle`), top frame only |
| Background | One `background.service_worker` file, ES module or classic |
| Runtime | `sendMessage`, `getURL`, `getManifest`, `getPlatformInfo`, `onMessage`, `onInstalled`, `onStartup` |
| Storage | `local`, `sync`, `session`, `onChanged`; plus ephemeral `ncc.storage.private` |
| Tabs | `query`, `get`, `sendMessage`, `reload` |
| Scripting | `executeScript` with packaged `files` |
| UI | `action.onClicked` (and `default_popup`), `contextMenus`, `notifications.create`, `i18n.getMessage` |
| Nostr | `ncc.nostr.getPublicKey`, `getProfile` (with `nostr:profile` permission), `signEvent`, `getRelays`, `nip04`, `nip44` |
| Blossom | `blossom:group-image` permits encrypted group-photo transport with the listed Blossom hosts |
| Contacts | `contacts:read` reads the active profile’s public follow list and cached profile labels through `ncc.contacts.state()` / `refresh()` |

Not supported in this version: `webRequest`, `declarativeNetRequest`, `cookies`,
`history`, `bookmarks`, `downloads`, `identity`, `offscreen`, `sidePanel`, DevTools
panels, `omnibox`, `commands`, `alarms`, and `runtime.connect` ports.

## Manifest additions

The only NCC-specific manifest key is optional:

```json
"ncc": { "min_version": "0.6.0" }
```

NCC pages use ordinary match patterns:

```json
"matches": ["ncc://*/*", "ncc://<npub>/<service>/*", "https://example.com/*"]
```

`*://*/*` keeps Chromium semantics and does **not** match `ncc://`; add `ncc://*/*`
explicitly.

## TypeScript

```ts
import type { NccManifest } from './packages/extension-sdk/types'

const manifest: NccManifest = {
  manifest_version: 3,
  name: 'Example',
  version: '1.0.0',
  permissions: ['storage', 'nostr:sign'],
  host_permissions: ['ncc://*/*'],
  content_scripts: [{ matches: ['ncc://*/*'], js: ['content.js'] }]
}
```

The global `chrome`, `browser` and `ncc` objects are declared by `types.d.ts`.

## Porting notes

`port` rewrites `browser_action`/`page_action` to `action`, `options_page` to
`options_ui`, removes unsupported permissions, optionally adds `ncc://*/*` to content
scripts, and writes `port-report.md` with every `chrome.*` call it cannot back. It
keeps the original manifest as `manifest.chromium.json`.

Private-tab access is a runtime grant, not a manifest key. Content scripts can read
private pages when the user allows it; `ncc.storage.private` is cleared when the last
private tab closes. Tor tabs never run extensions.
