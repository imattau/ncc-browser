# nccsearch bundle updates

Desktop and Android check GitHub's latest Nostr Navigator release once per day. A
version that differs from the bundled or installed ncc-server commit is offered to the
user. The bundle is installed under app data and activated on the next app launch; its
`nccsearch` origin stays stable, so its local index and settings remain available.

Release workflow signs `nccsearch-manifest.json` with Ed25519. The matching verification
key is pinned in the desktop and Android updaters. Before the first release that carries
updates, add the corresponding private key to the repository as the Actions secret
`NCCSEARCH_UPDATE_SIGNING_KEY_PEM`. For the current key generated during implementation,
the private key is in `/tmp/nccsearch-update-signing-key.pem`; add it with:

```sh
gh secret set NCCSEARCH_UPDATE_SIGNING_KEY_PEM < /tmp/nccsearch-update-signing-key.pem
```

Do not commit the private key. Rotate the updater key by updating both pinned public
keys and the Actions secret together.
