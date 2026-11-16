# Nostr Navigator for Android

**Alpha.** This is an early build published so the pipeline and the addressing model
can be tested on a real device. It is not a daily driver.

What works:

- NCC-05 resolution from relays, with SPKI (`k`) pinning of endpoints
- pages served through a loopback proxy, so the service stays part of the origin
  (`<npub>.<service>.localhost`)
- a content view that renders those pages and refuses anything outside that namespace
- a NIP-07 shim injected into documents, with the signer routes wired but not yet
  implemented

What is missing:

- identity and signer approvals — every signer call answers `501 signer-not-configured`
- tabs, history, bookmarks, downloads, settings
- the real browser chrome: the content view currently covers the shell
- extensions, private tabs and Tor, which the desktop build has and Android will not
  get in the same form

The desktop build is unaffected and remains the supported one.

If something breaks, the most useful report says which step failed: the proxy port on
the status page, whether `*.localhost` resolved, or the error the content view shows.
