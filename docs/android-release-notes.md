# Nostr Navigator for Android

## 0.47.10

- Private NCC-05 records can now be opened with the active local identity. Android also
  reads NCC-02 anchors without requiring a public `k` tag; private transport pins stay
  inside the encrypted locator.

## 0.47.9

- Maintenance release with no Android-specific changes.

## 0.47.8

- Maintenance release with no Android-specific changes.

## 0.47.7

- Maintenance release with no Android-specific changes.

## 0.47.6

- Maintenance release with no Android-specific changes.

## Improved in 0.47.5

- Pull-to-refresh now shows progress and completion feedback. Swiping a tab card to
  close it displays a close cue and slide-away animation.

## 0.47.4

- Maintenance release with no Android-specific changes.

## New in 0.47.3

- Swipe down on a page or in the tab switcher to reload the active page. Swipe a tab
  card left or right to close it.

## Fixes in 0.47.2

- Fixed links from other apps being lost while the browser starts or resumes.

## Fixes in 0.47.1

- Fixed identity settings failing to show saved additional signers, including after
  importing an nsec.

## New in 0.46.0

- Signer selection shows profile images and usernames when available, with a shortened
  npub beneath the name. Missing profile data falls back to the npub and an initial.
- Profile metadata is cached and refreshed from configured relays in the background.

## New in 0.45.0

- The toolbar now shows the active signer's Nostr profile avatar. Tap it to open the
  browser menu; long-press it to choose another signer when multiple identities are
  available.
- Fixed the site information panel's Android crash and saved tab closures immediately.

## Fixes in 0.44.4

- Viewing an `ncc://` site you don't own now offers a "Message this owner via White
  Noise" action in the site info panel, matching the desktop build.
- Fixed two bugs that could crash the site info panel with a `ReferenceError`
  (`kindOf`, `shortId` were never wired through).

## Fixes in 0.44.3

- Certificate errors are now clearly explained when a website is blocked. Date errors
  suggest checking the device clock or asking the site owner to renew the certificate.
  The site information badge now shows the connection as blocked instead of secure.

## Fixes in 0.44.2

- Clear the nsec input after successfully importing a local identity. Failed imports
  keep the field value so it can be corrected and retried.

## Updates in 0.44.1

- The Password Manager can reveal a saved password from its login list for 15 seconds,
  or temporarily show it with the eye button in the add/edit password field. Revealed
  passwords are hidden when the vault locks, the Password Manager closes, or the app
  moves to the background.

## New in 0.44.0

- Browser-owned notifications report completed or failed downloads.
- Optional background work keeps the browser running after it moves to the background,
  shown by an ongoing notification. It is off by default; NCC asks once on first start,
  and Android notification permission is requested when needed. Returning to the app
  stops the foreground service. This does not enable website notifications.
- Added a background work control to Android settings.
- Hardened home-screen shortcut icon decoding against malformed and oversized favicons.

## New in 0.43.0

- Add a normal tab to the browser home screen, and request a launcher shortcut. The
  shortcut uses the page icon when available and opens the site in NCC Browser.

## Fixes in 0.42.5

- Nsite links open immediately instead of waiting for a hidden relay manifest lookup,
  so the browser shows page loading while the site resolves.
- Blossom downloads try up to three servers concurrently and stop after 20 seconds,
  avoiding long waits when a manifest lists slow or unavailable servers.

## Fixes in 0.42.4

- Fixed the nccsearch update check and downloads failing on Android because their HTTPS
  client used reqwest's uninitialized platform verifier instead of the app's explicit
  TLS root configuration.

## Fixes in 0.42.3

- **Fixed: every https:// page and nsite got stuck loading forever**, with a blank tab
  and a progress bar that never finished. Certificate verification needs an Android-side
  init call that nothing in the app ever made, so every HTTPS fetch silently failed in
  the background instead of loading or showing an error. Affected every page since
  0.42.1 (likely earlier too) — this release fixes it.

## Fixes in 0.42.2

- A dialog-styled popup (the pattern most "Continue with Google" and similar sign-in
  buttons use) no longer loses its connection back to the page that opened it. WebView
  used to read the popup's destination and reopen it as a separate, unrelated tab,
  which broke the sign-in handoff back to the original page.

## Fixes in 0.42.1

- The Password Manager is now tied to the default identity. On unlock, older local
  identity vaults are merged into it; unavailable relays are retried on a later unlock.

## New in 0.42.0

- Version 0.42.0 (versionCode 42000). The password vault now supports synced favorites,
  filtering to favorites, and sorting by title or password update time. Favorite changes
  sync without changing the saved password's age.

## New in 0.41.0

- Version 0.41.0 (versionCode 41000). Maintenance release with no Android-specific
  behaviour changes; the desktop and Android builds stay on the same version.

## New in 0.40.1

- Version 0.40.1 (versionCode 40001). Maintenance release with no Android-specific
  behaviour changes; the desktop and Android builds stay on the same version.

## New in 0.40.0

- Version 0.40.0 (versionCode 40000). Maintenance release with no Android-specific
  behaviour changes; the desktop and Android builds stay on the same version.

## Fixes in 0.36.5

- The Linux npack and deb/rpm/flatpak launchers now declare the HTTP and HTTPS
  handlers, so Nostr Navigator appears in the default-browser lists on GNOME and
  COSMIC instead of only handling `ncc://` links.

## Fixes in 0.36.4

- Added a batch MCP tool for running up to 20 ordered browser operations in one call.

## Fixes in 0.36.1

- Fixed Android WebAuthn requests bypassing the NCC passkey manager because the WebView
  rejected its HTTPS origin rule.

## New in 0.36.0

- Added passkey creation and sign-in through the NCC encrypted password vault, with
  confirmation for each use and native authenticator fallback when no NCC credential
  matches.

## Fixes in 0.35.7

- Media previews in nccsearch stop playing when they are closed, and when you leave
  the page, instead of continuing in the background.
- Updated embedded nccsearch to ncc-server v0.2.18.

## Fixes in 0.35.6

- Fixed the Linux npack launcher icon on GNOME.

## Fixes in 0.35.5

- Site permission choices can be remembered during normal browsing. Private and Tor
  decisions remain limited to their session.

## Fixes in 0.35.4

- Desktop's embedded nccsearch page can use NIP-07 through the existing signer approval flow.
- Updated embedded nccsearch to ncc-server v0.2.15.

## Fixes in 0.35.3

- Fixed the Identity screen failing to open from Settings.
- Restored NIP-07 sign-in for Android's embedded nccsearch page, using the existing
  signer approval flow.
- Home-page icons now refresh when you revisit a site, so changed favicons replace
  stale saved icons.

## New in 0.35.2

- Updated embedded nccsearch with mobile-friendly search settings, local relay preferences,
  and discovery for events, live streams and short videos.

## Fixes in 0.35.1

- Lightning payments can be scanned from QR codes, and receive invoices display a QR code.
- Replaced native Lightning dialogs with styled in-app payment and invoice flows.

## New in 0.35.0

- Added payment-card autofill and save prompts for detected secure checkout forms.
- Added device-credential and optional Nostr signer confirmation before card autofill.
- Improved payment-card deletion, identity switching, and checkout-origin checks.

## Fixes in 0.34.2

- Pressing Back from local nccsearch now returns to the home page.

## Fixes in 0.34.1

- Added an nccsearch icon to the home bottom bar when local nccsearch is enabled.
- Removed the separate “Open nccsearch” button from Search settings.

## New in 0.34.0

- Added optional local nccsearch to Search settings. It indexes configured relays on
  the device, and search activity is not published.
- Fixed the embedded search page in Android by allowing its local frame and bundling
  its static assets into the app proxy.

## Fixes in 0.33.24

- Tapping a shortcut on the home page opens it again.

## New in 0.33.23

- Added a Lightning wallet tab with Nostr Wallet Connect, balance refresh, invoice
  creation, and in-app payments. Pages can request Lightning payments through WebLN;
  each payment requires user approval.
- Bitcoin, Monero, and Lightning wallet tabs now use currency icons.

## Fixes in 0.33.20

- The Monero wallet now shows Send, the QR code and address above the sync settings, matching
  the Bitcoin wallet.

## Fixes in 0.33.19

- Fixed Android startup and ensured the Downloads screen is included in production builds.

## Fixes in 0.33.18

- Monero scanning now shows real progress (block, total and percentage) instead of a constant 0%.
- Monero shows the cached balance and history immediately while the scan catches up, and
  Refresh no longer reopens the wallet if it is already open or syncing.
- Bitcoin and Monero send forms have a QR icon in the destination field that opens the camera
  and fills in the address (and amount, when the code includes one).
- Monero shows its address and QR code before the first scan finishes.
- Links opened from other apps (when NCC Browser is the default browser) now open in a new
  tab instead of just launching the app.
- `ncc://` and `nsite://` links from other apps open in NCC Browser.
- Restoring a Monero wallet explains that the restore height controls how long the first scan takes.

## Fixes in 0.33.17

- Keep the Bitcoin and Monero receive QR code and address inside the wallet screen when the
  address is long.

## Fixes in 0.33.16

- NCC Browser can now be selected as Android's default browser and handle HTTP/HTTPS links.

**Alpha.** An early build published so the browser can be tested on a real device. It
is not a daily driver.

## Fixes in 0.33.15

- Keep the Bitcoin balance card and its contents within the wallet viewport when the
  receive QR code loads.

## New in 0.33.14

- Manage multiple Nostr identities from Settings → Identity. Add local keys or NIP-46
  connections, switch the active signer for new NIP-07 requests, and choose a default
  identity that stays first in the list. The active choice is remembered across app
  launches.

## Fixes in 0.33.13

- Keep the Bitcoin wallet screen within the Android viewport after its receive QR loads.

## Fixes in 0.33.12

- Bitcoin receive QR codes stay within the Android wallet view.
- Monero resumes from an encrypted local wallet cache after sync, reducing repeat scan
  work. Concurrent sync requests are serialized to avoid overlapping wallet scans.

## New in 0.33.11

- Long-press a home shortcut to enter edit mode. Remove several shortcuts with the X
  controls, tap another shortcut to move it to the front, or tap outside the tiles to
  leave edit mode.

## Fixes in 0.33.9

- Profile pictures now load for the images people actually use. The app previously gave
  up on anything over 256 KB (most avatars), sent no User-Agent (some image hosts then
  refuse the request) and rejected images labelled with the wrong content type. It now
  accepts up to 4 MB, identifies itself, checks the image bytes, and keeps a small
  192-pixel copy so the local cache stays tiny.

## Fixes in 0.33.7

- Fixed the profile picture never appearing on Home when signed in. The app's image
  download used a TLS setup that does not work on Android, so it failed quietly and the
  letter avatar stayed. It now uses the same certificate roots as the rest of the app.
- Fixed the app logo on the Home page showing as a broken image before sign-in.
- Wallet service requests (Bitcoin balance, history and fees) use the same fix.

## Fixes in 0.33.6

- Fixed the Home profile avatar being blocked by the Android WebView's content policy.
  The image is now fetched by the app, size and type checked, and cached locally so it
  appears on later launches without contacting the image host again.

## New in 0.33.5

- Home is available from the … menu without closing open tabs. The Home page keeps
  Shortcuts and adds separate NCC Services and Nsites sections, with bookmarks before
  recent visits in each section.
- Share to Nostr now supports `nsite://` links as well as `ncc://` and web addresses.

## New in 0.33.4

- Tor tabs now open ordinary `https://` sites (and bare host names) through Tor, not
  just `.onion` addresses. Pages are fetched by the app over Tor, so your address is
  not revealed; scripts that build their own URLs at runtime may not work.
- Tor starts when the app opens, so the first Tor tab loads straight away. This is a
  setting (Settings → Tor → Start Tor when the app opens), on by default; turn it off
  to keep Tor idle until a Tor tab is opened.

## Fixes in 0.33.3

- Wallet screens now focus on the selected currency's balance, send action, receive
  QR and address; transaction history and network settings are tucked away.
- Locked Monero wallets show one concise identity-access message.

## Fixes in 0.33.2

- Wallets now explain that access follows the unlocked local Nostr identity; there is
  no separate wallet password. Locked Bitcoin and Monero states include a direct link
  to set up or unlock the identity.
- Bitcoin service errors remain distinct from identity lock errors, so an unavailable
  Esplora service does not incorrectly prompt for identity setup.

## New in 0.33.0

- Bitcoin wallet derived from the local Nostr identity, with balance, transaction
  history, receive address and QR, fee preview, and an explicit send confirmation.
- Monero wallet created or restored from its own 25-word seed. The seed backup must be
  confirmed before the wallet record is saved. Wallet data can stay on-device or sync
  as an encrypted Nostr record; scanning uses the configured remote daemon.
- Wallet creation and restoration require an unlocked local identity. Remote signers
  cannot create spend-capable wallets.
- The New Tor tab action now sits beside the normal and private tab actions in the menu.

## Fixed in this build

- Named services no longer resolve to the default `addr` record just because that
  record was refreshed more recently. `/search` and the other services open their own
  endpoint instead of the welcome page, matching the desktop build.
- Moving between services in the same tab no longer leaves a blank page until a
  reload. Ad blocking had been treating the page being left as the initiator of a
  top-level navigation and blocking it as third-party.
- Pages that keep their script policy in a `<meta>` CSP (npanel) load their own
  scripts again. The injected NIP-07 shim no longer narrows that policy to its own
  nonce, and a header without a script directive is left alone.
- Settings → Relays accepts an `ncc://` address (`ncc://<npub>` or
  `ncc://<npub>/<service>`) and resolves it to the relay's published `ws`/`wss`
  endpoint before saving.

## New in this build

- Fixed `ncc://` and `nsite://` links that could change the address bar without loading
  the destination. Links now resolve through the current page's proxy port, and links
  explicitly opened in a new window create a browser tab.
- Fixed fullscreen on embedded video players: pressing fullscreen no longer leaves a
  black screen. The video fills the screen and Back leaves fullscreen.
- Fixed ad and tracker filter lists never downloading on Android: Settings → Security
  stayed at 0 lists. They now update, and the list count is 6 (an empty Brave list was
  dropped).
- Share to Nostr. The menu has a new Share to Nostr item, separate from the normal
  Share. It posts a public note with the page address and an optional comment of your
  own, signed with your key. It goes to your configured relays and your own relay list
  (NIP-65), never to a vault relay. It only works in normal tabs while you are signed in,
  and nothing is posted until you tap Post. Tracking parameters such as `utm_*` and
  `fbclid` are removed from web links; `ncc://` addresses are posted as they are.
- A new Appearance setting, Back button, can hide the back arrow in the address bar to
  give the address more room. Auto hides it when the phone uses gesture navigation,
  Show always keeps it, Hide always removes it. Forward stays in the menu, and
  Back is the system gesture.

- Ad and tracker protection now uses maintained Brave, EasyList and uBlock filters.
  Standard blocks the common ad lists; Strict adds privacy lists. Cached lists work
  offline, Android can update them from Settings → Security, and cosmetic rules run
  before page scripts on supported WebView versions. Video and other media requests
  are classified using WebView request metadata where available.

- Sign-in with a Nostr extension now works on ordinary websites such as nostr.com.
  Before, only NCC and nsite pages could see `window.nostr`, so a site on the regular
  web reported that no NIP-07 extension was found. Each site is asked before it can read
  your public key or sign. Private and Tor tabs sign with a throwaway key kept in memory,
  never your own.
- Tracker and ad protection is now available in Settings → Security: Off, Standard or
  Strict. Strict adds privacy lists and blocks third-party cookies. Site information
  shows the protection level and blocked-request count, and lets you allow or restore
  protection for that site. Optional external-script blocking is also available.
- Sites now ask before using location, camera or microphone. Android still shows its
  system permission prompt when the app needs access.
- Passwords and sync now also use your own relay list (NIP-65), as the desktop build
  does, so a login or bookmark saved on one device is looked for on the relays the
  other device published to. It is on by default; Settings → Passwords has a switch,
  and a vault relay still overrides everything.
- Password sync now tells you when it could not reach a relay. Before, unlocking with
  no relay reachable looked like a successful sync.
- A login saved while you were offline is now sent as soon as a relay is reachable
  again. Before, it stayed on the phone until you saved something else.
- Sync between your phone and the desktop build. Settings → Sync can keep bookmarks,
  open tabs and history in step, each with its own switch, all off until you turn them
  on. Everything is encrypted to your own Nostr key before it leaves the phone, and
  private and Tor tabs are never included. Tabs open on your other devices appear under
  your normal tabs in the tab switcher. It needs an identity stored on this phone.
- Fixes onion addresses opening to a blank screen. Tor tabs now allow requests to the
  listener port in their own starting URL, even before the shell's port handoff is
  available.
- Fixes NCC pages failing with "Could not automatically determine the process-level
  CryptoProvider", most often after coming back from the background or restarting. The
  secure connection to relays had no TLS provider chosen once Tor support was added to
  the app, so a lookup that opened a relay connection failed. It is now chosen when the
  app starts.
- Private and Tor tabs now have a browsing session of their own. Their cookies, site
  data and cache are kept apart from normal tabs, so a private tab no longer shares or
  leaves cookies on a site you also use normally. They are discarded when the last tab
  of that kind closes, and anything left by an earlier run is deleted at startup. This
  needs a recent Android System WebView; on an older one the tabs still work but share
  cookies with normal tabs, and the notices say so.
- Tor tabs no longer sit blank while Tor starts. A page opened before Tor is ready now
  shows "Connecting to Tor" with its progress and loads by itself, or says why Tor
  could not start. Choosing "New Tor tab" also starts Tor straight away, so it is
  further along by the time you have typed an address.

## Also new since 0.28

Tabs

- Tabs survive a restart. Normal tabs are reopened in their old order, and only the
  one you were on loads; the rest wait until you pick them. Private and Tor tabs are
  never saved.
- Sites keep their web storage across restarts. The local proxy now reuses its last
  port when it is free, so a site's origin no longer changes every launch and logins
  held in the page's own storage are not lost.
- Normal, private and Tor tabs are clearly separate. The tab switcher has a
  Normal / Private / Tor switch with a count for each, and "Close all" and "New tab"
  act on the kind on screen. Private and Tor tabs have their own colours (indigo and
  purple) on the toolbar, address pill, address screen and switcher, a badge on the
  pill, and no page previews. They leave no history or saved icons.

Tor

- Fixes the app closing when Tor starts. Opening the Tor settings page or entering an
  onion address in a Tor tab crashed the app, and separately the built-in Tor client
  could not start at all.
- Searching from a Tor tab works: the address bar searches through DuckDuckGo's onion
  service (or your own onion search instance), and an engine with no onion service
  falls back to DuckDuckGo instead of refusing. Typing in a Tor or private tab's
  address bar stays in that kind of tab.
- Onion sites that only serve HTTPS, DuckDuckGo's among them, now load. They used to
  redirect forever because the Tor listener only ever spoke plain HTTP to onions.

Site information

- Clear a site's data from its information sheet: cookies and local storage, with an
  optional "forget trust decisions" switch that also revokes signer access and any
  cleartext exception.
- Signer access can be trusted or revoked from the same sheet, and Revoke acts on
  exactly the service you are looking at; before, it could revoke another service of
  the same identity.
- Clearnet pages get a proper sheet instead of an error. The sheet shows the kind of
  tab and, for onion pages, that the address authenticates the site.

Passwords and settings

- Passwords. The vault is the same NIP-78 event the desktop build uses, encrypted to
  your own key, so importing the same npub brings your logins with you. Unlock asks for
  your device lock, the decrypted vault is forgotten after a configurable idle time, and
  nothing plaintext is written to disk. Settings → Passwords manages logins (add, edit,
  delete, generator, 2FA codes, auto-lock, relay); the menu fills one into the current
  page, and submitting a login offers to save it. Filling works on https and ncc pages
  only, never in private or Tor tabs, and a page can never read a password back.
- Appearance settings include text size, four accent colours, compact spacing and
  reduced motion, alongside theme and toolbar position. Settings apply immediately and
  persist across launches.

Browser chrome

- A redesigned one-row toolbar (bottom or top) with an address pill, a shield badge
  that shows how the service was verified, tab count and menu; an address screen with
  suggestions from history and bookmarks; and a new-tab page with shortcuts and your
  identity state.
- Service icons: a site's own favicon is used on shortcuts, suggestions and tab cards.
- Tab switcher with thumbnails and close-all; swipe the address pill to change tab.
- Bottom-sheet menu: forward, reload, bookmark, share, find in page, desktop site,
  copy address.
- Load progress, stop, system back that closes the sheet in front first, light and dark
  themes.

## What works

- NCC-05 resolution from relays, with SPKI (`k`) pinning of endpoints
- pages served through a loopback proxy so each service keeps its own origin
  (`<npub>.<service>.localhost`), and `nsite://` sites
- an encrypted local identity and a NIP-07 signer with per-service approval prompts
- history, bookmarks, settings (relays, search engine, HTTPS policy and appearance), downloads
- NIP-46 remote signer sessions

## What is missing

- extensions, which the desktop build has and Android will not get in the same form
- pull to refresh
- a per-site cache clear: "Clear cache" in Settings → Storage clears every site's

The desktop build is unaffected and remains the supported one.

If something breaks, the most useful report says which step failed: the proxy port in
About, whether `*.localhost` resolved, or the error the content view shows.
