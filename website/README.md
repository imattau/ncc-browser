# Nostr Navigator website

The promotional site for Nostr Navigator, designed to be published as an nsite:
what it is, what it does, how to use it, downloads and links.

The stack follows Soapbox's [MKStack](https://soapbox.pub/mkstack) shape — React 19,
Vite, TypeScript, Tailwind CSS 4 and small local components — and uses
[Nostrify](https://nostrify.dev) (`NRelay1`) to read the latest `ncc-browser` release
event (kind `1063`) from relays. If no relay answers, the page falls back to the
current version and the GitHub release page.

## Build

```bash
cd website
npm install
npm run build      # -> website/dist
```

The build uses absolute asset paths, so it can be served at the root of an nsite origin
(`nsite://<npub>.<site>/`).

## Publish

1. Build the site.
2. In Nostr Navigator: **Settings → Sites → Choose folder** → `website/dist`.
3. Sign in as the Nostr Navigator identity, tick **root site**, and set title `Nostr Navigator`, source `https://github.com/imattau/ncc-browser`.
4. Keep the default Blossom servers and relays, then **Upload and publish**.
5. Verify the uploaded files and open `nsite://<npub>/`.

The site has no host, DNS or certificate. It is public; NIP-5A has no access control.

Live: `nsite://npub15d7l6vky77x34wu2rl2jdlafmpuycjsca06sjpmqgc7ggnd0zazsja3gma/`.
