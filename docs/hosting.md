# Hosted services and private links

Nostr Navigator can publish a locator for a service you run, so it has an identity
address instead of a domain:

```
ncc://<your-npub>/<service>
```

This is for **services** — things that need a running HTTP endpoint, logins or
server-side state. For a **static site**, use **Menu → Publish a site** (`nsite://`):
no endpoint, no TTL, no renewal. See [`site-publishing.md`](./site-publishing.md).

The service can be a home server, a laptop app, a dashboard, or anything that speaks
HTTP. The browser holds the identity and signs the locator; you do not need a domain,
a certificate or a reverse proxy. Reaching it directly from the internet still needs a
router port-forward; an onion endpoint does not.

The same mechanism shares a private service with exactly one person:

```
ncc://<your-npub>/share-1a2b3c4d5e
```

That link is an NCC-05 record whose payload is NIP-44 encrypted to the recipient's
npub. Relays see the author, the `d` tag and when it changed; they do not see the
endpoint.

## Publishing

Settings → **Services** → **Add service**.

| Field | Meaning |
| --- | --- |
| Name | Human label shown in the browser. |
| Service id | The `d` tag, e.g. `photos`. Lowercase letters, digits and hyphens. Immutable after creation. |
| Endpoints | Optional until publishing: one or more `http://`, `https://` or `.onion` URLs. A bare `IP:port` or `[IPv6]:port` is accepted and defaults to `http://`; an explicit `https://` keeps TLS (use it for a `k`-pinned endpoint). The first is preferred; the resolver falls back in order. **Find endpoints** proposes candidates from this machine, the current page and the router. |
| Visibility | **Private** encrypts the locator to you. **Public** publishes plaintext, so anyone with the address can resolve it. |
| Locator lifetime | How long the signed hint is valid. Default 7 days, maximum 30. |
| Anchor | Optional NCC-02 service record. A public service includes the endpoint; a private service omits `u` and `k` and anchors only the identity and expiry. |
| Note | Optional text, encrypted with the payload, shown to people you share with. |

NCC-02 anchoring is recommended but not mandatory. NCC-02 is the identity, intent and
trust context; NCC-05 supplies reachability. The browser's default is optional anchoring;
**Settings → General → Require NCC-02 service records** makes a fresh anchor mandatory.
For a private service the anchor has no `u` and no `k`: anyone can read an anchor, and
a fingerprint could be matched against servers found by scanning the internet. NCC-05
remains the only source of endpoints and pins. Publishing replaces an older anchor that
still has a `k`, even when anchoring is off, as far as the queried relays return it.
Relays and others may keep old copies.

The **address** (`ncc://<npub>/<service>`) is derived from the identity and service id,
not from the endpoints. The form shows it and lets you copy it before adding any
endpoint. You can save the address first; **Publish** and **Share** require at least one
reachable endpoint because a locator is only a pointer.

### Signing identity

A service is signed by the **active Nostr identity**. The Add service form shows the
identity list and uses the selected one; choosing another entry switches the active
identity for this and later services.

**New identity** creates a key with one checkbox:

- **Add to identity list** on (default) creates a normal local identity, saved and
  selectable in Settings → Identity.
- Off creates a **one-off** identity that exists only for this session. Copy its nsec
  before discarding it or closing the app; without the key the service cannot be
  renewed or shared later. A one-off can still be promoted to the saved list, which
  greys out the checkbox once its npub is present.
- Replacing or switching away from a one-off asks for confirmation.

Publishing never creates a signer implicitly: without an identity the submit is
disabled and the panel says one is needed.

### HTTPS without server setup

For a server that only speaks plain HTTP, the browser can add HTTPS in front of it. Type
the endpoints as you know them; you do not have to work out a second port or a pin.

- Press **HTTPS** on the saved service. If one of this machine's saved `https://`
  addresses turns out to be a plain HTTP server, **Publish** and **Share** turn it on
  for you.
- The browser finds the server from the endpoint ports and listens for TLS on port 8443,
  or another free port, on every network interface. The certificate and port are reused
  after a restart.
- Saved endpoints stay as typed. Publishing and sharing send these instead:

| Saved endpoint on the server's port | Published as |
| --- | --- |
| This machine (loopback, LAN or its own IPv6) | `https://` on the browser's port, pinned with `k` |
| Public address or domain | `https://` on the same port, pinned with `k` |
| `.onion`, another port, or another LAN machine | unchanged |

- Internet visitors need the router to forward the public port to this machine's
  **browser** port, not to the server's port. The service card shows the exact rule.
  The browser does not change the router for this.
- Keep the browser running. After turning HTTPS on or off, publish again.
- The server sees every visitor as a connection from this machine. Do not turn this on
  for a server that trusts local connections, such as an admin page without a login.

### TLS certificate

HTTPS endpoints can be pinned with `k`, a base64url SHA-256 of the certificate's SPKI.
The service form offers:

- **Import certificate** — choose a PEM/DER certificate; the browser derives the pin
  and switches matching endpoints to `https://`.
- **Generate self-signed** — picks a name from the endpoint, includes every endpoint
  host in the SAN list, writes `<name>-cert.pem` and `<name>-key.pem` (key `0600`) to a
  folder you choose, and pins it.
- **Remove pin** — clears `k`; existing `https://` endpoints then use normal CA
  validation.
These certificate options are for a server that serves TLS itself. Install
a generated certificate and key in whatever serves it, then start that server on the
HTTPS port. A certificate that does not name an endpoint host leaves that endpoint
unpinned and the form reports it.

### Strict anchoring

When **Require NCC-02 service records** is on, publishing becomes a two-part operation:

1. Publish the anchor (`kind 30059`) under the same `d` tag as the locator. A private
   service or share uses an anchor with only `d` and `exp`: **no `u` or `k`**.
2. Only if the anchor was accepted, publish the NCC-05 locator (`kind 30058`).

If no relay accepts the anchor, the locator is not published and the service/share is
reported as failed; this is deliberate, because a strict recipient would reject the
locator with `no-anchor`. In optional mode the anchor is best effort: a failure is
reported on the share/service, but the locator still works for recipients that do not
require anchoring.

A private share has its own `d` tag, so it also gets its own no-`u` anchor. The canonical
service anchor does not satisfy the share: anchored resolution looks up the anchor by the
requested `d` tag.

When strict mode is off, NCC-02 is shown as an optional trust anchor and a missing or
rejected anchor does not block publishing.

**Publish** signs a `kind 30058` locator and sends it to your configured relays plus
your NIP-65 read and write relays. The Services card shows how many relays accepted it
and the last error when none did.

The canonical locator is replaceable: publishing again creates a strictly newer event
for the same `d` tag. The browser renews a locator automatically at half its lifetime
while it runs. With a NIP-46 remote signer, renewal is manual: **Publish** on the card.

## Sharing privately

A share is the same payload encrypted to one recipient under a reserved `d` tag:

```
d = share-<12 hex chars>
```

The resolver also reads the multi-recipient wrapped form used by ncc-server's
sidecar for a private service: one `kind 30058` event with a per-recipient
encrypted session key. No separate link is needed for each reader in that form.

The suffix is random. Renewing an active share keeps its link; sharing again after it
was revoked or expired creates a new link. Links made up to v0.47.6 used an id that
anyone could recompute from the service id and a candidate recipient's public key. The
service card marks them: remove access, add the person again and send the new link. `share-` is reserved; service ids cannot
start with it. The resolver treats a `share-` service as exact-only: a missing or
expired share never falls back to the owner's generic `addr` record.

Adding or editing a private service opens **People** automatically so the contact list
is right there. You can also open it later from the service card; the button shows how
many people currently have a link.

To add people:

1. Open **Services**, choose a private service, and click **People**.
2. Choose one or more people from your Nostr follow list (kind 3), search by name,
   NIP-05 or npub, or paste an npub manually.
3. Pick an expiry and click **Create links**. Each recipient gets their own
   `ncc://…/share-…` link and their own no-`u` NCC-02 anchor. A loopback-only
   service must first gain a LAN, public or `.onion` endpoint.

Choosing several people creates several locator records: NIP-44 has one conversation
key per recipient, so a single ciphertext cannot address a group. The action is a batch
in the UI; each recipient's link is independent and can be revoked or renewed on its
own.

**People with a link** on the card lists everyone added. **Remove access** revokes that
person's link. A removed entry offers **Add again**, which makes a new link, or
**Delete from list**. In the picker, **Has access** marks people with a working link;
selecting one again renews it.

**Publish this page…** does not create a second service when one of yours already uses
that port on this machine; it points you to the existing card. **Add service** still
creates another one if you want it.

The contact list is cached in `userData/contacts.json` for instant opening and refreshed
from kind-3 and kind-0 events when it is older than six hours or when you press
**Refresh**. Profiles provide display names, NIP-05 identifiers and pictures; a contact
with no profile still appears under their npub. The cache is per signed-in identity.

The recipient opens the link in Nostr Navigator. Their active identity decrypts the
payload, the page loads, and the link appears under **Shared with me**. A different
identity gets an `undecryptable` page explaining which identity the share needs.

A share is a capability, not DRM: the recipient can read the endpoint and may pass it
on. **Remove access** (revoke) publishes an expired, endpoint-less tombstone so the link stops
resolving, but a recipient who already saved the endpoint can still reach it until the
service rotates or enforces its own authentication. Rotate the published endpoint (or
stop the old one) for a hard cut-off.

## Reachability and Tor

A locator is a pointer, not a tunnel. The address stays
`ncc://<npub>/<service>`; the endpoint has to be reachable from the recipient's network:

- **Direct** — a LAN address works on the same network; a public address needs the
  usual routing and firewall work.
- **CGNAT / no port-forward** — add a `.onion` endpoint from the service card. The
  bundled Tor creates and verifies it, so the service works from anywhere without a
  public IP or port forward. The locator carries the onion URL like any other endpoint.
- **Relay/tunnel** — a third-party tunnel (Cloudflare, Nabu Casa, a VPS) can front the
  service, but that reintroduces the middleman the identity address avoids.

A loopback endpoint (`127.0.0.1`, `localhost`, `::1`) is accepted for your own
service but is dropped from a share: the recipient's machine would resolve to itself.
A share with no non-loopback endpoint is refused.

## Endpoint discovery

**Find endpoints** works without opening a page. It scans this machine's interfaces
using the **Port** field (or the first endpoint's port, or 80/443), checks whether a TLS
pin is configured and whether Tor is running, and lists candidates as checkboxes. You
can also seed it with a normal `http(s)://` page, a bare `IP:port`, an IPv4 address or a
bracketed IPv6 address; a bare address defaults to `http://`, while an explicit
`https://` (or any configured pin) keeps HTTPS. The service form shows each candidate
with its source and a confidence label:

| Candidate | Example | Confidence |
| --- | --- | --- |
| This machine | `http://127.0.0.1:8080` | owner only |
| Local network | `http://192.168.1.20:8080` | same network |
| IPv6 | `http://[2001:db8::20]:8080` | globally routable, firewall-dependent |
| Current page | `https://photos.example/` | verified by the page |
| Tor onion | `http://abc…onion:8080` | loaded through Tor |
| Public IPv4 | `http://203.0.113.42:9000` | unverified |

Discovery reads only the current page, `os.networkInterfaces()` and the local
gateway. It does not contact an external address service. Link-local addresses
(`169.254.0.0/16`, `fe80::/10`) and unique-local IPv6 (`fc00::/7`) are skipped.

The panel also reports whether Tor is running. Creating an onion endpoint still
happens after the service is saved; a loopback-only candidate needs Tor for remote use.

The router's WAN address is read over UPnP, then NAT-PMP. Its class decides the
advice:

- `100.64.0.0/10` is **carrier-grade NAT**: direct IPv4 cannot work without a tunnel,
  so plan on Tor.
- A private WAN address means **double NAT**; the public address cannot be confirmed
  from the router alone.
- A public WAN address still needs a port forward and a reachability check.

A global IPv6 address is normally directly routable without NAT, so IPv6 is often the
simplest direct path; the remaining question is the host or router firewall.

Discovering an address is not a promise that a port is open. A public IPv4 candidate
stays **unverified** until a port mapping and a reachability check confirm it.

### Automatic onion endpoints

A service with a loopback endpoint (for example `http://127.0.0.1:8080`) gets an
**Onion** action. It asks the bundled Tor to create a hidden service:

```
ADD_ONION NEW:ED25519-V3 Port=80,127.0.0.1:8080
```

The onion address is added to the locator and verified by connecting through the same
SOCKS proxy the browser uses. An HTTPS endpoint maps to virtual port 443 so TLS passes
through unchanged; the certificate will not match the onion name, so pin it with `k`.

Details:

- The private key is stored in `userData/tor-services.json` (`0600`, atomic) and reused,
  so the address survives restarts. Remove deletes the key and the running service.
- Tor re-attaches stored onions whenever it becomes ready. If a stored onion exists at
  launch, Tor starts in the background and re-attaches it, so the published endpoint is
  live again; publishing a service with an onion endpoint also re-attaches first. The
  onion only exists while Tor and this browser run.
- Removing the hosted service removes its onion too.
- The bundled Tor exposes a loopback control port with cookie authentication. An
  external Tor needs `NCC_TOR_CONTROL` (and `NCC_TOR_COOKIE` or
  `NCC_TOR_CONTROL_PASSWORD`); without one the action reports that onion services are
  unavailable instead of guessing a port.
- NAT-PMP/UPnP port mapping is not used: nothing is opened on the router.

### External address confirmation

Confirming the real internet egress needs an external service, because the router
only reports what it believes its uplink to be. That check is a user choice, not a
silent request:

- **Settings → General → Check public address when publishing** is `Ask` (default),
  `Always` or `Never`.
- With `Ask`, the service form shows **Check public address** and names the provider
  (`api64.ipify.org`). The provider sees the user's IP address; it is not sent the npub,
  service name or endpoints.
- With `Always`, discovery runs the lookup automatically. With `Never`, no external
  request is made and direct IPv4 stays unverified.
- The result is cached for ten minutes. It never runs while **Prefer Tor** is on,
  because the lookup would discover the Tor exit rather than the user.
- A lookup that matches the router WAN is reported as confirmed; a mismatch is flagged
  as carrier-grade NAT or another NAT layer. A confirmed IPv6 egress is informational
  only: inbound IPv6 uses the host's global address, not the egress address.

Discovery is still only discovery. A confirmed address does not prove that a port is
open.

### Router port mapping (UPnP / NAT-PMP)

When the router answers and a loopback candidate exists, the form offers **Map a TCP
port on the router**. It is an explicit action, never automatic:

- UPnP IGD is tried first; if it does not answer, NAT-PMP is used through the default
  gateway (port 5351).
- The mapping forwards one TCP port to the first private IPv4 interface, is described
  as `Nostr Navigator`, and has a two-hour lease.
- The mapped URL is added to the endpoint list as **unverified**.
- **Check reachability** opens a TCP connection to the mapped public address and port
  through a Tor exit node — an external vantage point that needs no extra third-party
  service. Success marks the mapping reachable from the internet; the port itself is
  still yours to secure.
- While Tor is already running, mappings are re-checked every ten minutes. Two failures
  in a row raise one **Mapped port stopped answering** alert in Services with **Check
  again** and **Dismiss**; a later success clears it. The monitor never starts Tor and
  never opens a mapping.
- **Remove mapping** deletes it, and quitting the browser removes all mappings it
  created. A crash cannot leave a permanent hole because of the lease.
- A non-public WAN address (CGNAT, private, link-local) is refused: mapping cannot fix
  it. Use a Tor onion endpoint instead.
- The public address can change; the address watcher reports it, and re-mapping plus
  republishing is a deliberate step.

## Address changes

The browser checks interface addresses once a minute and the router's public WAN
address every ten minutes. When an IPv4 address, an IPv6 prefix or the WAN address
changes, **Services** shows a banner with the old and new value. Two actions are
offered:

- **Update & republish** replaces matching endpoints across all services (host, port and
  path preserved), signs a new locator for each changed service and publishes it. A
  remote signer may ask for approval.
- **Update endpoints only** rewrites the local records and leaves publishing to you.

A per-service publish failure is reported and does not stop the others. Dismiss removes
the notice without changing anything.

Removing an interface or roaming is reported the same way. Loopback, link-local and
unique-local IPv6 addresses are ignored because publishing them is never useful.

## Relays and discovery

The locator is published to:

1. the relays configured in Settings → General;
2. the read and write relays from your own NIP-65 list (kind `10002`), capped and
   deduped.

The recipient's resolver queries its configured relays plus the author's NIP-65
read-marked relays, so a share is discoverable without out-of-band relay hints. A
private relay only works if both sides know about it.

Encryption hides the payload, not the metadata: anyone reading the relays can see that
a locator exists, who signed it, its service id or share id, its expiry and size, and
when it changed. For sensitive services, use a neutral service id and an identity that
is not linked to you, use your own relay and prefer a full Tor tab. Visitors to a
direct endpoint see its IP address; to avoid that, publish only an onion endpoint.

Private is not access control. It limits who can read the address from relays. Anyone
who finds an open port can use the service, including after a share is revoked, so a
service that is not meant for everyone needs its own login.

## Security model

- The store is `userData/services.json`, mode `0600`, written atomically. It contains
  no key material.
- Signing always goes through the active identity provider. A local key signs in the
  main process; a NIP-46 signer asks the remote device.
- Private locators are NIP-44 encrypted to the owner. Shares are NIP-44 encrypted to
  the recipient. The event signature still proves the author.
- Endpoints must be `http`, `https` or `.onion` URLs without embedded credentials.
  `file:`, `javascript:` and `data:` are refused.
- A public service cannot use a loopback endpoint, and a public service cannot be
  shared because anyone with the address can already resolve it.
- Revocation is best-effort. The real control is the endpoint and the service's own
  authentication.

## Limits

- Locators renew only while the browser is running. An always-on agent (a small
  headless renewer next to the service) is future work.
- NIP-59 gift-wrap shares are not implemented. Each share has its own `d` tag, so the
  link differs per recipient.
- Onion service creation is manual: run a Tor hidden service and enter its `.onion`
  URL. The browser does not call `ADD_ONION` yet.
- Android has no Services UI yet.
- A share record is public metadata even when encrypted; an observer can count shares
  and see when they are renewed or revoked.
- A service is published under the identity that signed it. Switching identities and
  publishing again creates a different address; the Services card names the owner and
  refuses to publish or share it under the wrong identity.

## Testing

Unit and integration tests:

```bash
npx vitest run test/hosting-events.test.ts test/hosting-store.test.ts test/hosting-service.test.ts
```

End-to-end UI smoke (real Electron, Xvfb, a local `nak` relay, a scratch profile):

```bash
npm run e2e:hosting
```

Opt-in live relay check (three identities: owner, recipient, stranger):

```bash
nak serve --port 10547 &
NCC_HOSTING_RELAY=ws://127.0.0.1:10547 npx vitest run test/hosting-live.test.ts
```

The live test covers: owner decrypts their own private locator; the recipient decrypts
a share; a stranger gets `undecryptable`; a missing `share-` address returns
`no-record` rather than the owner's `addr`; a tombstone returns `expired`.
