# Nostr Navigator for Android

**Alpha.** An early build published so the browser can be tested on a real device. It
is not a daily driver.

## New in this build

- Tor tabs no longer sit blank while Tor starts. A page opened before Tor is ready now
  shows "Connecting to Tor" with its progress and loads by itself, or says why Tor
  could not start. Choosing "New Tor tab" also starts Tor straight away, so it is
  further along by the time you have typed an address.
- Site information can now clear a site's data: its cookies and local storage, with an
  optional "forget trust decisions" switch that also revokes signer access and any
  cleartext exception. Signer access can be trusted or revoked from the same sheet,
  and Revoke now acts on exactly the service you are looking at; before, it could
  revoke another service of the same identity.
- Clearnet pages get a proper site information sheet instead of an error.
- Private tabs no longer claim to keep cookies out: cookies are shared with normal
  tabs on this device, and the notices now say so.
- Fixes the app closing when Tor starts. Opening the Tor settings page or entering an
  onion address in a Tor tab crashed the app, and separately the built-in Tor client
  could not start at all. Both are fixed: it now connects in about ten seconds.
- Tabs survive a restart. Normal tabs are reopened in their old order, and only the
  one you were on loads; the rest wait until you pick them. Private and Tor tabs are
  never saved.
- Sites keep their web storage across restarts. The local proxy now reuses its last
  port when it is free, so a site's origin no longer changes every launch and logins
  held in the page's own storage are not lost.
- Passwords. The vault is the same NIP-78 event the desktop build uses, encrypted to
  your own key, so importing the same npub brings your logins with you. Unlock asks for
  your device lock, the decrypted vault is forgotten after a configurable idle time, and
  nothing plaintext is written to disk. Settings → Passwords manages logins (add, edit,
  delete, generator, 2FA codes, auto-lock, relay); the menu fills one into the current
  page, and submitting a login offers to save it. Filling works on https and ncc pages
  only, never in private or Tor tabs, and a page can never read a password back.
- Searching from a Tor tab now works: the address bar searches through DuckDuckGo's
  onion service (or your own onion search instance), and an engine with no onion
  service falls back to DuckDuckGo instead of refusing. Typing in a Tor or private
  tab's address bar stays in that kind of tab.
- Onion sites that only serve HTTPS, DuckDuckGo's among them, now load. They used to
  redirect forever because the Tor listener only ever spoke plain HTTP to onions.
- Normal, private and Tor tabs are now clearly separate. The tab switcher has a
  Normal / Private / Tor switch with a count for each, and "Close all" and "New tab"
  act on the kind on screen. Private and Tor tabs have their own colours (indigo and
  purple) on the toolbar, address pill, address screen and switcher, a badge on the
  pill, and no page previews. Tor tab visits no longer reach the history.
- Appearance settings now include text size, four accent colours, compact spacing and
  reduced motion, alongside theme and toolbar position. Settings apply immediately and
  persist across launches.
- A redesigned browser chrome: one-row toolbar (bottom or top) with an address pill, a
  shield badge that shows how the service was verified, tab count and menu.
- Address screen with suggestions from history and bookmarks; new-tab page with
  shortcuts and your identity state.
- Service icons: a site's own favicon is used on shortcuts, suggestions and tab cards.
- Tab switcher with thumbnails and close-all; swipe the address pill to change tab.
- Bottom-sheet menu: forward, reload, bookmark, share, find in page, desktop site,
  copy address.
- A trust sheet in the style of a privacy panel: signed locator, pinned certificate or
  HTTPS, transport, and whether the service may sign without asking (with revoke).
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

- private tabs, Tor and extensions, which the desktop build has and Android will not
  get in the same form
- pull to refresh

The desktop build is unaffected and remains the supported one.

If something breaks, the most useful report says which step failed: the proxy port in
About, whether `*.localhost` resolved, or the error the content view shows.
