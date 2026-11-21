# Site publisher

A standalone page that publishes a static NIP-5A site: pick a built folder, hash every
file, upload the blobs to Blossom (BUD-02), sign a `kind:35128` manifest with a NIP-07
signer, and publish it to relays. The result is an `nsite://<npub>/<site>` address that
Nostr Navigator serves with every file verified against the signed hashes.

This is based on the nsite publisher in
[`ncc-server/ncc-search/nsite-publisher`](../../vendor/ncc-server/ncc-search/nsite-publisher),
adapted for Nostr Navigator's built-in signer and generic site defaults.

## Build

The root `npm run build` runs `scripts/build-site-publisher.mjs`, which installs this
folder's dependencies, builds `dist-nsite/`, and copies it to
`resources/site-publisher/`. The app serves that folder at `nccpublish://app/`.

For standalone development:

```bash
cd site-publisher
npm install
npm run dev      # http://127.0.0.1:5174
npm test
```

Open the dev URL in Nostr Navigator (it has a signer) or in any browser with a NIP-07
extension.

## Use

1. Choose the built folder (the one containing `index.html` at its root).
2. Set the site id (1–13 lowercase letters, digits and dashes), title and description.
3. Keep or edit the Blossom servers and relays.
4. Connect the signer and publish. Approve `nccpublish://app` once and choose
   **Always allow** so the per-file Blossom authorisations and the manifest do not
   prompt again.
5. Copy the `nsite://` address, then use **Verify uploaded files** once.

Republishing with the same site id replaces the manifest. Unchanged files are already on
Blossom by hash and are not uploaded again.

## Limits

- Blossom keeps content-addressed blobs; a server may garbage-collect unpinned data.
  Publish to more than one server, and keep the source folder if you need to re-upload.
- Content is public. There is no private nsite in NIP-5A.
- 25 MB per file (the browser's fetch limit); keep sites small.
- The page must reach the Blossom servers and relays directly. A server without CORS
  will fail the upload from the page.
