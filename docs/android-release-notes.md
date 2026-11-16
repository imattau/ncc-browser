# Nostr Navigator for Android

**Alpha.** An early build published so the browser can be tested on a real device. It
is not a daily driver.

## New in this build

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
- history, bookmarks, settings (relays, search engine, HTTPS policy, theme), downloads

## What is missing

- private tabs, Tor and extensions, which the desktop build has and Android will not
  get in the same form
- pull to refresh

The desktop build is unaffected and remains the supported one.

If something breaks, the most useful report says which step failed: the proxy port in
About, whether `*.localhost` resolved, or the error the content view shows.
