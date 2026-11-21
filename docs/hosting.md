# Hosted services and private links

Nostr Navigator can publish a locator for a service you run, so it has an identity
address instead of a domain:

```
ncc://<your-npub>/<service>
```

The service can be a home server, a laptop app, a dashboard, or anything that speaks
HTTP. The browser holds the identity and signs the locator; you do not need a domain,
a certificate, a reverse proxy, or a port-forward on a public IP.

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
| Endpoints | One or more `http://`, `https://` or `.onion` URLs. The first is the preferred endpoint; the resolver falls back in order. |
| Visibility | **Private** encrypts the locator to you. **Public** publishes plaintext, so anyone with the address can resolve it. |
| Locator lifetime | How long the signed hint is valid. Default 7 days, maximum 30. |
| Anchor | Optional NCC-02 record for a public HTTPS service. Never used for private services because it would leak the endpoint. |
| Note | Optional text, encrypted with the payload, shown to people you share with. |

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

The suffix is a stable hash of the service id and the recipient, so the same pair
reuses one share instead of piling up records. `share-` is reserved; service ids cannot
start with it. The resolver treats a `share-` service as exact-only: a missing or
expired share never falls back to the owner's generic `addr` record.

To share:

1. Open **Services**, choose a private service, and click **Share**.
2. Enter the recipient's npub (or 64-character hex key) and an expiry.
3. **Create link** publishes the encrypted record and shows the link to copy.

The recipient opens the link in Nostr Navigator. Their active identity decrypts the
payload, the page loads, and the link appears under **Shared with me**. A different
identity gets an `undecryptable` page explaining which identity the share needs.

A share is a capability, not DRM: the recipient can read the endpoint and may pass it
on. **Revoke** publishes an expired, endpoint-less tombstone so the link stops
resolving, but a recipient who already saved the endpoint can still reach it until the
service rotates or enforces its own authentication. Rotate the published endpoint (or
stop the old one) for a hard cut-off.

## Reachability and Tor

A locator is a pointer, not a tunnel. The endpoint has to be reachable from the
recipient's network:

- **Direct** — a LAN address works on the same network; a public address needs the
  usual routing and firewall work.
- **CGNAT / no port-forward** — publish a `.onion` endpoint. The bundled Tor reaches
  it from anywhere, and the service never needs a public IP. The locator carries the
  onion URL like any other endpoint.
- **Relay/tunnel** — a third-party tunnel (Cloudflare, Nabu Casa, a VPS) can front the
  service, but that reintroduces the middleman the identity address avoids.

A loopback endpoint (`127.0.0.1`, `localhost`, `::1`) is accepted for your own
service but is dropped from a share: the recipient's machine would resolve to itself.
A share with no non-loopback endpoint is refused.

## Relays and discovery

The locator is published to:

1. the relays configured in Settings → General;
2. the read and write relays from your own NIP-65 list (kind `10002`), capped and
   deduped.

The recipient's resolver queries its configured relays plus the author's NIP-65
read-marked relays, so a share is discoverable without out-of-band relay hints. A
private relay only works if both sides know about it.

Encryption hides the payload, not the metadata: relays can see that a locator exists,
who signed it, which `d` tag it uses and when it changed. For sensitive services, use
your own relay and prefer a full Tor tab.

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
