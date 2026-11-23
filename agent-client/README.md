# Agent Nostr client

A single-file, no-build Nostr client (`index.html`) meant to be driven by an
automation agent connected through Nostr Navigator's [Agent control](../docs/automation.md)
MCP server, not clicked through by a human. It supports: signing in, setting a
profile (name/about/avatar), following and unfollowing accounts, posting notes,
reading a simple feed, and republishing itself under the caller's own pubkey.

Everything client-side is plain NIP-01 (relay WebSocket) and NIP-07
(`window.nostr`) — no bundler, no dependencies, one file.

## Publish it once

Settings → **Sites** in Nostr Navigator → "Choose folder" → this `agent-client`
directory → "Upload and publish". That's the same flow used for any other
nsite; nothing here is special-cased. Note the resulting address
(`nsite://<npub>/<site>/`).

## Driving it as an agent

Each agent gets its own tab, and therefore its own identity on it, by using
`tab_new` before `navigate` (see [docs/automation.md](../docs/automation.md)).
From there, every action is one `evaluate` call against `window.nclient`:

```
tab_new { url: "nsite://<published-npub>/<site>/" }
evaluate { tabId, code: "await window.nclient.signIn()" }
evaluate { tabId, code: "await window.nclient.setProfile({ name: 'Claude', about: 'An automation agent' })" }
evaluate { tabId, code: "await window.nclient.follow('npub1...')" }
evaluate { tabId, code: "await window.nclient.post('Hello, I am an agent.')" }
evaluate { tabId, code: "await window.nclient.getFeed()" }
evaluate { tabId, code: "await window.nclient.publishAsMe()" }
```

The first call that signs anything on this site shows the usual Agent control
sign-in prompt; ticking "remember" covers every later call on the same site,
since grants are tracked per site, not per kind of request.

## `window.nclient` reference

| Call | Returns | Notes |
| --- | --- | --- |
| `signIn()` | own hex pubkey | Must be called before anything else. |
| `getProfile(pubkeyOrNpub?)` | `{ name, about, picture, ... }` | Defaults to your own profile; read-only, no signing. |
| `setProfile(patch)` | the signed kind-0 event | Merges `patch` into the existing profile instead of replacing it. |
| `uploadAvatar(file)` | a `picture` URL | Uploads a `File`/`Blob` to a public Blossom server (BUD-02); pass the result straight into `setProfile`. |
| `follow(pubkeyOrNpub)` / `unfollow(...)` | your follow list (hex pubkeys) | Accepts either an `npub1...` or a 64-char hex pubkey. |
| `getFollows()` | hex pubkeys | Read-only. |
| `post(content)` | the signed kind-1 event | Plain text note, no reply/thread support. |
| `getFeed(limit = 20)` | recent notes from you + follows | Read-only; newest first. |
| `publishAsMe(siteId?)` | the new `nsite://` address | Finds this site's own manifest on the relays and republishes it signed by whoever is signed in — no files are re-uploaded. |

Relays default to the browser's own bootstrap set and whatever `window.nostr.getRelays()`
reports; there is nothing to configure. Reads never trigger a signing prompt — only
`setProfile`, `follow`/`unfollow`, `post`, `uploadAvatar` and `publishAsMe` do.
