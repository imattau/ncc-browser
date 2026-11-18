# Nostr Navigator for Android

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
