# Extension store design

Status: stage 1 is implemented. Stages 2 to 4 are proposals.

## Layers

| Layer | Choice | Job |
| --- | --- | --- |
| Releases | [npack](https://github.com/imattau/npack) | Signed releases, file hashes, listing details, revocations |
| Store | A page in the browser, beside Settings → Extensions | Browse, verify, review access, install, update |
| Curation | A signed list of publishers from a chosen Nostr key | Whose extensions the store shows |
| Web catalogue | An nsite, later | Browse and share listings |

The browser does every check and owns the approval step. A web page, including the
nsite, never installs code. At most it may later ask the browser to open its own review.

## Stages

### 1. Reviewed installs (implemented)

Every install from the UI is staged, shown for approval, and installed from the staged
copy. The review lists permissions and every website pattern, and marks what an update
adds. See [extensions.md](extensions.md).

### 2. Signed packages

**Package layout.** An `.npk` with npack kind `navigator-extension`, `os` and `arch`
`any`, and the extension under `extension/`:

```text
.npack/manifest.json
extension/manifest.json
extension/...
```

npack refuses to install a kind it does not know, so the system package manager cannot
unpack an extension into the host. A local test with npack 0.11.4 packed the White
Noise companion this way, `npack verify` accepted its manifest, and `npack install`
refused it. Publishing and relay discovery for this kind are untested.

**Verification.** Before the review opens, the browser checks:

1. the kind:9900 release event ID and signature, protocol version and `kind` tag;
2. that the kind:1063 artifact event has the same publisher and SHA-256;
3. the downloaded bytes against that SHA-256, with a size limit;
4. that no kind:9901 revocation from the publisher refers to the release;
5. that the package name and version match the release, and that the version in
   `extension/manifest.json` matches too.

Unpacking needs zstd, which Electron's Node provides, and a tar reader with the same
path, link, file count and size limits as the ZIP reader. Download URLs come from a
stranger: allow only HTTPS to public hosts, including after redirects.

**Identity.** A store install is identified by publisher key plus package name, never
by path or display name. The same name from another publisher is another extension,
with separate storage. A local file install can never replace a store install, and the
reverse is also true.

**Updates.**

- Every update goes through the review. Silent updates are out of scope.
- An older version is not offered as an update.
- A revoked installed release is flagged. Open question: should it also be disabled?
- If relays cannot be reached, say that revocation status is unknown. Do not report
  the release as safe.

**Private tabs.** Default the grant to off for a first store install.

**Publishing.** A script wraps `npack init`, `pack` and `publish`, reusing the file
list in `scripts/package-white-noise-companion.mjs`.

### 3. Store page

**Curation.** The curated list names publishers, not releases, which matches npack:
trust attaches to a publisher key. A listed publisher's new releases and extensions
appear without a new list. Listing a publisher does not skip any check, and every
install and update is still reviewed. Removing a publisher takes their extensions out
of the store but does not uninstall them. The store's list is separate from the user's
npack trust settings and does not change them.

Proposed format: a NIP-51 follow set (kind 30000) with one `p` tag per publisher,
signed by the curator's key. The browser accepts only that key's signature.

The curator key is the one that signs the project's Zapstore listing:

- `npub1khf5amw8mrupe649a5mhkk3d2d8wjj06urz6kwawpftk4f68tjlstdmd3q`
- hex `b5d34eedc7d8f81ceaa5ed377b5a2d534ee949fae0c5ab3bae0a576aa7475cbf`

Navigator's npack releases, and its own extensions, are published with the existing
npack publisher key, not the curator key:

- `npub1g3vdg46zq7xpkmtdnta7l8u9684zd2p4e9wrp3xd7wv4xk7vq03svh653x`
- hex `4458d45742078c1b6d6d9afbef9f85d1ea26a835c95c30c4cdf399535bcc03e3`

The curator list therefore needs a `p` tag for that publisher.

Release CI holds the curator's secret key as `ZAPSTORE_NSEC`, so anyone who can run
code with that secret can also sign the publisher list. Signing the list is a manual
step; CI should not publish it.

**Discovery.** Relays index only single-letter tags, so they cannot filter on npack's
`kind` tag. The store asks for kind:9900 events by the listed authors, then filters by
kind itself. An open catalogue would need an indexable tag, which would be
a change to the npack protocol.

Listing text and images are untrusted. Follow the listing rules in npack's package
protocol: limit lengths, strip control characters and verify the icon hash.

A release from an unlisted publisher can still be installed from its release
reference, with a warning.

### 4. Wider access

An nsite catalogue, then publishing from inside the browser. Android has no extension
host, so the store is desktop-only.

## Trust model

A valid signature shows who published the bytes. It does not show that they are safe.
Extensions can read the pages they match, and with the private-tabs grant, private
pages too. A curated list is a recommendation by its signer, not an audit.

## Open questions

- Should a revocation disable an installed extension automatically?
- npack user attestations are only proposed. The store does not depend on them.
