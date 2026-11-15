# Bundled Tor

`npm run tor:fetch` (or `node scripts/fetch-tor.mjs <target>`) stages the pinned Tor
Expert Bundle here:

- `linux-x64/`
- `mac-x64/`
- `mac-arm64/`
- `win-x64/`

The directories are gitignored. The version and SHA-256 pins live in
[`scripts/tor-version.json`](../scripts/tor-version.json). Packaged builds copy the
matching directory into the app's `resources/tor` folder.

Targets used by the release workflow:

```bash
node scripts/fetch-tor.mjs linux-x64
node scripts/fetch-tor.mjs mac-x64 mac-arm64
node scripts/fetch-tor.mjs win-x64
```

Tor updates are security updates: bump the version and every checksum together, then
run the packaging smoke test. Each staged directory gets `TOR-LICENSE.txt` and
`TOR-NOTICE.txt`; both ship inside the packaged app.
