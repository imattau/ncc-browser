# NCC Publisher

A small web app that publishes NCC-05 locators (kind `30058`) and optional NCC-02
service records (kind `30059`) for a service running on a local port.

It never asks for an `nsec`: every event is signed by a NIP-07 provider. That can be a
browser extension (Alby, nos2x, …) or **Nostr Navigator's built-in signer** when this page is
opened inside the browser.

## Run

```bash
cd publisher
npm install
npm run dev
```

Open `http://localhost:5173`.

To use the built-in signer, open the same URL in Nostr Navigator:

1. Start the publisher with `npm run dev`.
2. In Nostr Navigator, type `http://localhost:5173` in the address bar.
3. Click **Connect signer**. The browser shows its normal per-service approval sheet.
4. Fill in the local port and publish.

With a normal browser, a NIP-07 extension injects `window.nostr` instead.

Build a static copy:

```bash
npm run build
# dist/ can be served from any static host
```

## What it publishes

- **NCC-05 locator**: `kind 30058`, `d` = service id, `expiration` tag, and a payload
  with `v`, `ttl`, `updated_at` and endpoints. Public by default; optional NIP-44
  encryption to your own key.
- **NCC-02 anchor**: `kind 30059`, `d` = service id, `u` = the primary endpoint, `k` =
  the optional transport SPKI fingerprint, and `exp`. The browser displays this as the
  service's trust anchor and can use `u` as a fallback when NCC-05 has no endpoint.

The address is always:

```
ncc://<your npub>/<service>
```

It stays stable when the port or host changes. Republish the locator instead.

## Privacy and reachability

- `127.0.0.1` only works when Nostr Navigator runs on the same machine. Use a LAN address
  (`192.168.x.x`, `10.x.x.x`, …) for another device, and allow the port through the
  firewall.
- A plaintext locator exposes the endpoint to relays and anyone who knows the npub. Use
  the encryption option for private endpoints; the reader must use the same local key or
  NIP-46 signer to decrypt it.
- `k` is the TLS SPKI fingerprint (`base64url(sha256(SPKI DER))`). Include it for HTTPS
  endpoints when you want the browser to pin the certificate, including self-signed
  certificates.
- `ws://`/`wss://` endpoints are published for other clients; Nostr Navigator renders
  `http`/`https` pages, including `.onion` HTTP(S) endpoints through its bundled Tor.

## Stack

The Stacks CLI/MKStack alias was not reachable from this environment, so this uses the
same stack as MKStack (React 19, TypeScript, Vite, Tailwind 4, `nostr-tools`) with a
focused single-page UI. It is intentionally separate from the browser's trusted chrome:
Nostr logic and the UI live here, while key material and relay resolution stay in the
browser's main process.
