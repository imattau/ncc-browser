# Publishing a site

There are two ways to publish with Nostr Navigator:

- **Settings → Sites** (or **Menu → Publish a site**) is the native publisher. It uses
  the active identity, the main-process relay pool and a native folder picker.
- **`nccpublish://app/`** is the bundled standalone page, adapted from the ncc-server
  nsite publisher. It is useful on its own and is still linked from the Sites page.

Both build the same NIP-5A manifest. The native path is the primary one because it
avoids browser CORS and per-file NIP-07 prompts.

## The model

A static site is not a running service. It is:

1. a folder of files, each addressed by sha256 and stored on Blossom;
2. a signed manifest (`kind 35128` for a named site, `15128` for the root site) that
   lists every `path` and `server`;
3. an address: `nsite://<npub>/<site>/` or `nsite://<npub>/` for the root site.

There is no endpoint, no DNS, no certificate, no port forwarding, no TTL and no
renewal. A reader fetches the manifest from relays and each file from Blossom, then
checks every byte against the signed hash before serving it.

For anything that needs a running HTTP endpoint, logins or server-side state, use
**Services** (`ncc://`) instead. See [`hosting.md`](./hosting.md).

## Native flow

1. Build the site so the folder contains `index.html` at its root (for example a Vite
   `dist/` folder).
2. **Settings → Sites → Choose folder**. The folder is scanned in the main process:
   dotfiles, `__MACOSX` and symlinks are skipped; every file is hashed locally.
3. Set a site id (1–13 lowercase letters, digits and dashes), or tick **root site**.
   Add a title, description and optional source URL.
4. Choose the Blossom servers and relays. The defaults are public servers; the relay
   list starts from Settings → General.
5. **Upload and publish**. Every file is uploaded to every server, the manifest is
   signed by the active identity, and published to the relays.
6. **Copy** the `nsite://` address, or **Open** it. **Verify** downloads every file back
   and checks its hash.

Republishing with the same site id replaces the manifest. Files whose bytes did not
change keep their hash and are not uploaded again; only new or changed assets are
uploaded. The browser stores the manifest index in `userData/nsite-sites.json` (mode
`0600`), not the site files.

Opening **Sites** also queries the configured and NIP-65 relays for the active
identity's latest kind 15128/35128 manifests and rebuilds missing entries. This is how a
site published from another profile or device reappears. Removing a site adds it to a
hidden list in the index, so discovery does not resurrect it; republishing the same
address clears the hidden entry. Two files are enough to distinguish a discovery from a
local publish: the manifest's `created_at` and its event id.

**Cancel** aborts the in-flight upload or relay publish between files and tears down the
current request. Blobs that were already accepted stay on Blossom (their address is
their hash); no site record or manifest is written for a cancelled publish. Verify can
also be cancelled.

## Removing and restoring

**Remove** asks for confirmation, signs a NIP-09 deletion request (`kind 5`) with an `a`
tag for the site address (`35128:<pubkey>:<siteId>`, or `15128:<pubkey>:` for the root)
and an `e` tag for the manifest, and publishes it to the site relays. The local record
is removed and added to the hidden list. Relays treat deletion as advisory: a manifest
that is merely retained does not reappear because discovery also queries `kind 5` and
skips manifests covered by a deletion.

To restore a deleted site, republish it from its source folder with the same site id.
The new manifest has a newer `created_at`, so it wins over the deletion, and publishing
clears the hidden entry. Without the source folder the old manifest cannot be
reconstructed once relays honour the deletion. If no identity is available or the active
identity does not own the site, Remove stays local and says so.

## Blossom and relays

- BUD-02 upload: `PUT /upload` with `X-Sha-256` and a signed `kind 24242`
  authorization. A server that says "already have it" is a success.
- Every file is uploaded to every configured server. The manifest lists only servers
  that accepted at least one file, so readers have more than one place to fetch each
  blob.
- The manifest is published to the configured relays plus the identity's NIP-65 write
  relays. The nsite resolver reads configured relays, so keep the relays your readers
  use in Settings → General.
- The native path uses the relay pool, including NIP-42 AUTH when a relay asks for it.

## Limits

- Content is **public**. NIP-5A has no access control and no private nsite. Use a
  hosted service if the content must be restricted.
- 25 MB per file (the browser's fetch limit) and 512 MB per site.
- Blossom servers may garbage-collect unpinned blobs. Publish to several servers and
  keep the source folder so you can re-upload.
- Replacing a manifest hides old files from new readers, but old blobs may remain on
  Blossom. There is no deletion guarantee.
- The browser does not keep the site files, only the manifest index. Republishing
  needs the source folder again.
- A NIP-46 remote signer will prompt on the device for the upload authorisations and
  the manifest. A local identity signs without a prompt.
- The Sites index is local, but entries are discovered again from the active identity's
  manifests on the relays. A site published under a different identity requires
  switching to that identity first.

## Standalone page

`site-publisher/` is a fork of
[ncc-server's nsite publisher](https://github.com/imattau/ncc-server). It is built by
`npm run site-publisher:build`, bundled into `resources/site-publisher`, and served at
`nccpublish://app/` on the normal session only. It is a useful fallback for a machine
where the native publisher is unavailable, and it can publish itself as an nsite.

The page uses the built-in NIP-07 signer. Approve `nccpublish://app` once and choose
**Always allow** so the per-file upload authorisations do not prompt each time.

## Testing

```bash
npx vitest run test/nsite-publish.test.ts test/nsite-publish-service.test.ts test/nsite-blossom.test.ts
npm --prefix site-publisher test

# Opt-in: real relay + local Blossom stand-in
nak serve --port 10549 &
NCC_NSITE_RELAY=ws://127.0.0.1:10549 npx vitest run test/nsite-publish-live.test.ts
```

The service tests cover scanning, hashing, manifest signing, upload fan-out,
republishing and verification. The BUD-02 test uses a local HTTP server.
`npm run e2e:hosting` drives the native Sites flow end to end against a local `nak`
relay and Blossom stand-in, then loads the standalone publisher with the built-in
signer.
