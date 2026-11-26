# Android UI

What the browser chrome should be, why, and what of the desktop carries over.

## What the three browsers converged on

| | Toolbar | Tabs | Primary actions |
|---|---|---|---|
| Chrome | Top or bottom, moved by long-pressing the address bar | Button opens a card grid; swipe up from the bottom bar also opens it | Reload / share / bookmarks / downloads / settings in overflow |
| Firefox | Bottom by default, layout customisable | Tab tray, list or grid | Menu sheet holds history, bookmarks, downloads, settings |
| Brave | Bottom toolbar (optional, on by default) | Tab indicator in the bar; long-press closes the tab or all tabs | Shields panel from the bar; long-press new tab for a private tab |

Four things all three do, and none of them put a second toolbar row on screen:

1. **One row.** Controls that do not fit move into a sheet. Firefox's own users complained
   when a forward button made the toolbar taller — the constraint is real.
2. **Address is the biggest target.** Tapping it, not a separate search widget, is how
   navigation starts.
3. **Tabs are a sheet, not a strip.** The bar shows a count or a single tab chip.
4. **Bottom beats top on large phones** for reachability. Chrome and Firefox both offer
   it; Firefox ships it as the default.

## What NCC is, and what that changes

NCC's address is an identity, not a domain, and the interesting state is per service:
the locator record, the endpoint, the pin, the transport, and whether this service may
sign. That means:

- The **lock chip** carries more than a padlock. It is the identity: npub, service,
  transport (clearnet / pinned / onion) and signer trust. It opens a sheet.
- **Signing is a browser-level action**, not a page action. The approval prompt must be
  reachable from anywhere, and it must not be dismissible by the page.
- There is **no URL to type** in the usual sense — the bar accepts `ncc://`, `npub`,
  hex, and search terms. Suggestions matter more than autocomplete of domains.

## Layout

One row at the bottom of the screen, above the gesture bar:

```
┌─────────────────────────────────────────────┐
│                                             │
│                 content                     │
│                                             │
├─────────────────────────────────────────────┤
│  ←   │  npub1…/search        🔒 │  3  │  ⋮  │
└─────────────────────────────────────────────┘
   back        address pill          tabs  menu
```

- **back** — history within the page; long-press opens the full history list.
- **address pill** — shows the canonical `ncc://npub/service/path`, truncated from the
  left so the service stays visible. Tap expands the shell to a full-screen address
  sheet. Long-press copies.
- **lock chip** — inside the pill, at its trailing edge. Tap opens site info. Colour
  follows the desktop's security states: pinned / TLS / plaintext / unknown.
- **tabs** — current count, opens the switcher. Long-press closes the current tab.
- **menu** — sheet.

The bar is 56 dp, sits below the content, and is inset for the gesture bar. The status
bar and camera cutout are the page's problem, not the bar's: content is inset at the
top, the bar at the bottom. This also sidesteps the notch entirely.

Why bottom rather than the top strip we have today: reachability, and it matches what
Firefox and Brave ship by default. The top strip was a scaffolding choice, not a design
decision.

## Screens

**Address sheet** (expands in place, replaces the page view while open)
- Input with the current address selected.
- Suggestions, in order: this service's siblings (`web`, `ditto`, …), history, bookmarks,
  then "search with …" for anything else.
- Recent services, each as `npub/service` with its label.
- Dismiss by swiping down or pressing back; the page is untouched underneath.

**Tab switcher** (full screen sheet)
- Cards, two per row, with a captured thumbnail and the service label.
- Close per card; "close all"; "+" opens the address sheet in new-tab mode.
- Long-press on the tab count closes the current tab, matching Brave.

**Site info sheet** (bottom sheet, ~60 % height)
- Identity: npub, service, d-tag source.
- Transport: endpoint host, pinned (`k` prefix), via Tor, HTTP warning.
- Record: event id, updated at, expires at.
- Signer: trusted or asks every time, with a "revoke" action.
- "Clear data for this service".

This is the mobile form of `SiteInfoPanel.tsx`, which is already structured as
sections; it becomes a sheet without new information.

**Signer prompt** (full-height modal, cannot be dismissed by the page)
- Service, method, kind, content preview.
- Approve / Deny, "don't ask again for this service".
- Timeout shown as a countdown, because the proxy denies after 120 s.

**Menu** (bottom sheet)
- New tab, history, bookmarks, downloads, find in page, share, settings.

**Settings** (full screen, drilled down from a list)
- Identity (create, import, unlock, lock, remove).
- Relays, gossip, anchors.
- Appearance.
- Signer permissions.
- About, and the alpha notice.

## Desktop → mobile mapping

| Desktop surface | Mobile | Notes |
|---|---|---|
| `TabStrip.tsx` (drag, overflow, mute) | tab count + switcher sheet | drag-to-reorder only in the sheet, long-press |
| `Toolbar.tsx` + `AddressBar.tsx` | address pill + address sheet | same suggestions, no hover affordances |
| `SiteInfoPanel.tsx` | site info sheet | same sections |
| `SignerPrompt.tsx` | full-height modal | same content, plus a countdown |
| `ChromeMenu.tsx` | menu sheet | same items minus window controls |
| `SettingsPage.tsx` (1.6 k lines, sidebar) | list → detail | sections carry over whole |
| `PasswordSettings/Panel` | settings section + sheet | Autofill integration is out of scope |
| `DownloadsPanel`, `HistoryPanel` | sheets | same data |
| `Welcome.tsx` | first-run sheet in the address area | |
| `SecurityNotice.tsx` banners | strip under the bar | must not push content |
| Window controls, zoom, devtools, shortcuts | — | dropped |
| Extensions | — | dropped, not deferred |
| Private and Tor tabs | "ephemeral" single mode | see below |
| `nsite://` sites | same rendering path | no UI difference |

**Private and Tor.** Desktop isolates them as separate sessions; Android cannot. Two
honest options: (a) one "private" mode that clears cookies and storage on exit, labelled
as such, or (b) no private mode in the alpha. Tor is app-wide or absent, because
`ProxyController` has no per-WebView scope. Recommendation: ship neither until the
signer work has settled, then add private as clear-on-exit with a plain-language label.

## Interaction details

- **Back** — system gesture and button: page history, then tab switcher if more than one
  tab, then close the tab, then close the app. Long-press back opens history.
- **Swipe left/right on the bar** — previous/next tab, as Brave does. Cheap and it makes
  multi-tab usable one-handed.
- **Pull to refresh** — pull down at the top of a page, hold, then let go; sliding back
  up cancels. It starts only when the engine reports a drag the page did not use, and
  honours the root's `overscroll-behavior`. `PullGesture.kt` holds the rules
  (`mobile/pull-hold.js` for the tab switcher).
- **Long-press in a page** — a sheet for links, pictures, email addresses and phone
  numbers, with the address always shown. "Open in new tab" loads behind the page and
  offers "Switch". In a normal tab a link can also be shared to Nostr, through the same
  screen as the page menu. A private tab offers only private tabs; a Tor tab offers only what
  stays inside Tor. Text and form fields keep Android's own menu, and a page that
  handles `contextmenu` keeps the press. `LinkMenu.kt` holds the rules.
- **Long-press the address pill** — copy the canonical address.
- **Insets** — content inset at the top for the cutout, bar inset at the bottom.

## Architecture

The chrome is the Tauri webview; pages are native WebViews below it.

```
Tauri webview (React chrome)  ──invoke──▶  Rust: proxy, identity, signer
        │                                   ▲
        │ JavascriptInterface               │ HTTP on 127.0.0.1
        ▼                                   │
Kotlin: tab manager + one WebView per tab ──┘
```

Two consequences:

- **Tabs are Kotlin objects.** Each tab is a `WebView` plus its back/forward state,
  created lazily and parked (visibility gone) rather than destroyed, capped at 6–8 to
  stay inside the memory budget. The chrome asks for a tab switch; it never touches a
  WebView.
- **`NccApi` needs an adapter.** The desktop renderer talks to `window.ncc` (≈90
  methods). On Android, `NccContent` covers navigation and `invoke` covers identity,
  settings and site data. Building the adapter is what lets `AddressBar`, `SiteInfoPanel`
  and the settings sections be reused rather than reimplemented.

## Build order

1. **Bar and tabs.** Move the strip to the bottom; tab model in Kotlin; switcher sheet;
   new/close/switch; swipe on the bar. No React yet — the current plain bundle grows a
   tab sheet. This is the slice that makes the app usable.
2. **React chrome.** Mobile entry with the `NccApi` adapter, then swap the bar for
   `AddressBar` + tab chip, and the switcher for a React sheet. From here, desktop
   components can be pulled in one at a time.
3. **Sheets.** Site info, menu, history, bookmarks.
4. **Settings.** Table of contents → sections, reusing the desktop sections wholesale.
5. **Signer polish.** Countdown, permissions list, revoke.

## Open questions

- Bar at the bottom always, or a setting? Chrome and Firefox both offer the choice; it
  is two lines of layout, so a setting is cheap, but it doubles the visual QA per release.
- Thumbnails in the switcher need `PixelCopy` per tab; worth it for six tabs, or use the
  service label alone for the alpha?
- Does "recent services" belong in the address sheet or the tab switcher?

## Status of this pass

Built in `mobile/` plus small bridge additions in `MainActivity.kt` / `ContentSurface.kt`:
SVG icon set; one-row strip with an address pill (lock chip coloured by pinned / TLS /
cleartext, stop/reload, progress line on the content edge); omnibox with history and
bookmark suggestions; new-tab page with shortcuts; tab switcher cards with close-all;
bottom-sheet menu (forward, reload, bookmark, share, find in page, desktop site, copy);
site-info and signer bottom sheets with a blurred capture of the page behind;
drill-down settings; swipe on the pill to change tab; system back closes the sheet in
front first; keyboard insets lift the strip.

Not done: forced theme does not recolour the system bars, private tabs,
long-press tab count to close.
