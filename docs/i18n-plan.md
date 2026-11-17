# Language support plan (desktop and Android)

Scope: the plumbing for language support. No translations are written. English stays the only shipped language.

## Current state (from code review, not run on devices)

- All UI text is hard-coded English: 22 renderer components and the main process on desktop, `mobile/index.html` and `mobile/main.js` on Android.
- No setting for language, no `Accept-Language` control, no `lang` or `dir` handling (`mobile/index.html` fixes `lang="en"`).
- Spellcheck is off on both platforms.
- `chrome.i18n.getMessage` exists in `src/preload/extension-shim.ts` but its message map is always empty.
- Android `res/` has no `values-xx` folders and no `locales_config.xml`.
- Dates use `toLocaleString()` with no locale argument.

## Goals

1. One string layer shared by both UIs, English only for now.
2. A Language setting: "System" (default) or a specific language.
3. A deliberate `Accept-Language` policy per tab kind.
4. Correct `lang` / `dir`, with a layout that survives RTL.
5. Extension `_locales` support.

## Phase 0 - Verify (small, do first)

- Capture the `Accept-Language` actually sent by the Android WebView and by each Electron session (normal, private, Tor) against a header-echo page. Record the results here.
- Confirm Android per-app language behaviour on an API 33+ emulator.

Done when: observed headers are written down and the policy in Phase 3 is confirmed or changed.

### Phase 0 results (2026-11-18)

Android 0.32.3 debug build on an API 29 emulator, `https://httpbin.org/headers`:

| Case | Observed `Accept-Language` |
| --- | --- |
| Normal tab, system locale en-US | `en-US,en;q=0.9` |
| Normal tab, system and app locale fr-FR | `fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7` |
| Private tab, fr-FR | `fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7` |

Findings:
- Android WebView sends the system or per-app locale by default. Nothing in the app overrides it, and private tabs behave the same as normal tabs. The Phase 3 fixed-`en-US` policy for private tabs is therefore real work, not a no-op.
- The user agent carries `NostrNavigator/0.32.3`, and requests carry `X-Requested-With: io.github.imattau.nccbrowser.debug`. Both are stable identifiers and worth a separate privacy look.
- Cleartext `http://` pages (including `10.0.2.2`) are refused with `ERR_CLEARTEXT_NOT_PERMITTED`, so header checks need an https endpoint.
- `cmd locale set-app-locales` works on the debug package, so per-app language can be tested without changing the system language.

Not verified:
- Android Tor tab (not tried).
- Desktop: navigation to httpbin through the ncc-browser MCP timed out and `get_page_text` was refused for the blank tab, so no desktop header was captured. The host locale is en_AU.
- `navigator.language` / `navigator.languages` on either platform.

## Phase 1 - String layer (English only)

Shared design
- Catalogue format: flat JSON per language, `locales/<tag>.json`, keys like `settings.sync.lastSynced`. Values use ICU-style `{name}` placeholders and a `_one` / `_other` suffix for plurals.
- `t(key, params?)` helper, about 60 lines, no dependency. It falls back to English and then to the key. `Intl.PluralRules` handles plurals.
- Dates and numbers go through `Intl.DateTimeFormat` / `Intl.NumberFormat` with the active locale passed in.
- A lint script fails the build if a key used in code is missing from `en.json`, or an `en.json` key is unused.

Android (`mobile/`)
- `mobile/i18n.js` holds `t()` and `applyDom()`. Static HTML gets `data-i18n`, `data-i18n-placeholder` and `data-i18n-aria` attributes. JS template strings become `t()` calls.
- Convert in this order: settings, sync, downloads, share, prompts, then the rest.
- Replace the hand-built plurals (for example `'tab' : 'tabs'`) with plural keys.

Desktop (`src/`)
- `src/shared/i18n.ts` holds `t()`, imported by both main and renderer. The renderer gets the active locale and catalogue over IPC at startup and on change.
- Convert the 22 renderer components, then the user-facing strings in `src/main` (dialogs, menus, notifications).
- Menus and dialogs built in main use the same helper.

Done when: every user-facing string is a key, lint passes, the UI is visually identical, and existing tests pass.

## Phase 2 - Language setting and document language

- New setting `language`: `"system"` or a BCP 47 tag. It is stored in the existing settings store on each platform.
- Resolution: `system` maps to the OS locale (`app.getLocale()` / `navigator.language`), matched to the nearest shipped catalogue, else `en`.
- Set `<html lang>` and `dir` from the resolved language. Dir is `rtl` for ar, he, fa, ur and so on.
- Switching language re-renders live without restart on both platforms.
- Android: add `res/xml/locales_config.xml` listing shipped languages, reference it from the manifest (`android:localeConfig`), and add `resourceConfigurations` / `localeFilters` in Gradle. Translate `app_name` only if the product name is meant to change per language. Default: it does not.
- Desktop: set `electronLanguages` in `electron-builder.yml` to the shipped list to trim the Chromium locale packs.
- Setting appears in Appearance on both platforms.

## Phase 3 - Accept-Language policy

Proposed:
- Normal tabs: send the user's resolved language (plus `en` as fallback with a q-value).
- Private and Tor tabs: fixed `en-US,en;q=0.9` so language does not help fingerprint the user. `navigator.language` and `navigator.languages` should agree with the header.
- Internal requests (proxy clients, filter-list downloads, relays): unchanged. They identify as `NostrNavigator/<version>`.

Implementation:
- Desktop: `session.setUserAgent(ua, acceptLanguages)` per session, plus `webRequest.onBeforeSendHeaders` only if needed. The Electron `--lang` switch is set before `ready` when the setting is not `system`.
- Android: set the header through the WebView request interception that `ContentSurface.kt` already controls, or through the proxy, whichever Phase 0 shows is the single point all page requests pass through. For `navigator.language` spoofing in private and Tor tabs, use an injected script alongside the existing page injection.

Done when: a header-echo page shows the expected value in each tab kind on both platforms, and a test asserts it.

## Phase 4 - RTL and layout robustness

- Replace physical CSS (`margin-left`, `padding-right`, `left`, `right`, `text-align:left`) with logical properties in `mobile/style.css` and the renderer styles.
- Flip directional icons (back, forward, chevrons) under `[dir=rtl]`.
- Test with a pseudo-locale (`en-XA`: accented, 40% longer text, and an RTL variant) generated from `en.json`, to catch truncation and layout breaks before real translations exist.

## Phase 5 - Extension `_locales`

- Read `_locales/<lang>/messages.json` in main when an extension loads (the TODO in `src/preload/extension-page.ts`).
- Resolve in the Chrome order: exact, language only, `default_locale`. Support `__MSG_name__` in the manifest and CSS.
- Populate `bridge.i18n`, add `chrome.i18n.getUILanguage` and `getAcceptLanguages`, and support `$1` and named placeholders.

## Phase 6 - Spellcheck (optional)

- Currently off. If wanted: a setting, `setSpellCheckerLanguages` on desktop, and the Android WebView's system spellchecker. Not required for the rest.

## Testing

- Unit: `t()` fallback, plural rules, placeholder substitution, language resolution.
- Lint: key coverage between code and `en.json`.
- Integration: header-echo check per tab kind (Phase 3), `lang` / `dir` on the document, live language switch.
- Visual: pseudo-locale and RTL screenshots on both platforms (Android emulator, desktop via the ncc-browser MCP).
- Existing suites (vitest, cargo) stay green after Phase 1.

## Order and release

1. Phase 0, then Phase 1 (largest, split into two PRs: Android UI, then desktop).
2. Phase 2 and 3 together as the user-visible release, tagged as a minor release on each platform (`android-v*` and `v*`).
3. Phase 4 with the pseudo-locale in CI, then Phase 5.

## Risks

- Phase 1 touches most of the UI code, so it will conflict with feature work. Land it in small, per-screen commits and avoid parallel edits to `mobile/main.js`.
- `Accept-Language` spoofing in private and Tor tabs must match `navigator.languages`, or the mismatch becomes a fingerprint of its own.
- Android WebView may send its own language header after our interception. Phase 0 settles this.
- The `ncc://` and onion paths go through the proxy. The header policy has to hold there too.

## Open decisions

- Which first non-English language to ship, if any, and who translates it.
- Whether the private-tab `Accept-Language` should be fixed to `en-US` (recommended) or follow the user.
- Whether the product name is ever translated (recommended: no).
