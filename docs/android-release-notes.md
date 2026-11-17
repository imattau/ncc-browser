# Nostr Navigator for Android

**Alpha.** An early build published so the browser can be tested on a real device. It
is not a daily driver.

## New in this build

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
