# Page-requested signer selection — design note

**Status:** idea for later; not implemented

## Problem

NCC lets a user keep several local and NIP-46 identities, but `window.nostr` signs
with the browser's active identity. A site can offer its own account picker and change
its selected account without the browser knowing. The site and signer can then disagree
about which account is active. The browser can notify a site when NCC changes accounts
through `accountsChanged`, but NIP-07 has no standard page-to-signer account-selection
request.

## Proposed capability

Add an NCC-specific method to the injected `window.nostr` provider:

```ts
requestAccount(pubkey: string): Promise<string>
```

The page passes the public key it wants to use. NCC accepts only a key belonging to a
currently configured identity. If the request is approved and that identity is still
available, NCC switches the active signer and resolves with the selected public key.
The normal `accountsChanged` event then informs the page and other open pages of the
new active account.

The method is a request, not a setter: a page cannot silently change the browser's
identity. It must not accept secrets, a profile id, an identity creation/import request,
or a caller-supplied origin. The browser derives the caller's origin from its trusted
frame context, as it does for current signer requests.

## User interaction and permission

- Show the requesting site origin, current account, and requested account in the
  browser-owned approval UI.
- Switching requires an explicit approval for each request in the first version.
  Do not add a remembered grant until a separate product decision defines its scope,
  revocation, and whether it can be limited to a particular target identity.
- On approval, re-check that the target identity still exists, switch it, notify open
  normal pages with `accountsChanged`, and resolve the request.
- On denial, unavailable identity, or a failed switch, reject with a clear error and
  leave the active identity unchanged.
- Private and Tor contexts must not be able to switch the durable normal identity.
  Their existing per-session signer behavior remains isolated.

## Platform integration

- **Desktop:** expose the method through the isolated content preload. Main-process IPC
  derives the page origin/frame, validates the target against `IdentityManager`, asks
  through the existing signer approval UI, then switches and broadcasts the account
  change to eligible open tabs.
- **Android:** add the method to both page-facing NIP-07 paths: the ordinary-site
  document-start WebView shim and the proxy-served NCC page endpoint. Rust derives the
  origin from the WebView/proxy context, validates and approves the request, switches
  the active profile, and routes the resulting account-change event to eligible normal
  WebViews. Private/Tor signers remain isolated.
- Keep both implementations behaviorally aligned. Existing pages that do not call the
  new method continue using the browser-selected identity; existing `getPublicKey`,
  signing, and encryption methods keep their current behavior.

## API behavior and edge cases

- Accept the public-key format used by NIP-07 (`hex`); reject malformed keys before
  showing approval UI.
- A request for the already active key resolves successfully without switching or
  emitting a redundant `accountsChanged` event.
- If multiple profiles ever resolve to the same public key, select the canonical
  profile already used by the identity manager and report the key, not its internal
  profile id, to page code.
- Serialize overlapping selection requests so a slower approval cannot unexpectedly
  override a later user decision. Revalidate the target immediately before switching.
- A successful switch affects subsequent signer calls globally in normal browsing;
  this matches the existing global active-identity model. The prompt must make that
  scope clear because other open normal pages will receive the account-change event.
- Remote NIP-46 selection can fail while connecting or if the remote signer cannot
  provide its public identity. In that case, reject and retain the prior active signer.

## Acceptance and tests

- Unit tests cover malformed and unknown keys, active-key no-op, approved selection,
  denial, removed targets, and overlapping requests.
- Desktop integration tests verify origin attribution, approval contents, selection,
  rejection behavior, and `accountsChanged` delivery to other open normal pages.
- Android tests cover both the ordinary-site bridge and proxy-served NIP-07 route,
  including selection result and event delivery to normal tabs.
- Cross-platform manual test: with two identities configured, choose the second account
  in a test page; approve in browser chrome; confirm the page's promise resolves, its
  `accountsChanged` handler receives the selected key, and the next signing request is
  signed by that identity. Repeat with denial and in private/Tor contexts.

## Open decision for implementation

The proposal assumes an explicit approval on every switch and a globally active normal
identity. If the product instead wants a remembered per-site grant or a signer scoped
to one tab/site, decide that before implementation because it changes permissions and
how subsequent signing calls select their provider.
