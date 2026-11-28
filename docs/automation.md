# Agent automation (prototype)

Nostr Navigator can expose its tabs to a local MCP client such as Claude Code or Codex.
This is off by default. The browser hosts the MCP server itself, so no extension is
involved.

## Enable

**Settings → Agent control → Allow agent control.** The server listens on
`127.0.0.1:47821` (a free port if that is taken). Each agent you add gets its own Nostr
identity and its own ready-made connect command. Click **Add agent**, name it, and (once
the password manager is unlocked) copy the command it shows and run it once in a
terminal:

```bash
claude mcp add --transport http ncc-browser http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <agent's nsec>"
```

An agent's nsec *is* its bearer credential — there is no separate token. It is created
once, stored in `automation-settings.json` in the profile (mode 0600) and survives
restarts, so the connection is made only once. It is also saved as an entry in the
password manager (titled `Agent: <name>`), so it can be found and copied again later via
**Reveal** on that agent's card — the vault must be unlocked to reveal it. Each agent has
its own site grants, independent of every other agent. **Regenerate identity** replaces
one agent's keypair and disconnects any client still using its old nsec; **Remove**
deletes the agent entirely. Turning the top-level setting off stops the server for every
agent at once.

Developers: `NCC_AUTOMATION=1` forces the server on, `NCC_AUTOMATION_PORT` pins the
port, and the current `{ url, agents }` (each agent's id and nsec) is written to
`automation.json` while it runs. To try it without touching your real profile use a
scratch config home:

```bash
XDG_CONFIG_HOME=/tmp/ncc-scratch NCC_AUTOMATION=1 npm run dev
```

An MCP client's `initialize` call gets this back in `instructions`, so any agent — not
just one already familiar with this app — knows not to try to create a second identity:
the connection already has one fixed Nostr identity (the keypair generated once in
Settings → Agent control), `tab_new` ties a tab's `window.nostr` to it, and setting up a
profile/posting/following is just signing and publishing the matching kind of event
(or using `window.nclient` on a page that defines one, such as `agent-client/`).

## Tools

`batch` (up to 20 ordered tool calls), `tabs_list`, `tab_new`, `tab_close`, `navigate`, `read_page` (numbered interactive
elements), `get_page_text`, `get_console_logs`, `screenshot`, `click`, `hover`, `type`,
`press_key`, `scroll`, `evaluate`, `approvals_status`, `approvals_revoke`.
Batch calls run sequentially, stop on the first error, and return each completed result
in order. Earlier actions are not rolled back if a later call fails.

Browser development tools are a separate permission scope, independent of site access.
The first `open_settings`, `chrome_read_page`, `chrome_screenshot`, `chrome_click`,
`chrome_type`, `chrome_press_key`, `extension_panel_read_page`,
`extension_panel_get_page_text`, `extension_panel_get_console_logs`,
`extension_panel_screenshot`, `extension_panel_click`, `extension_panel_type`,
`extension_panel_press_key` or `extension_panel_upload_files` call shows the same Agent
control popup, identifying
the request as browser development access. A session grant for this scope does not grant
access to any website, and site grants do not grant access to browser settings. The
chrome tools can open General, Identity, and Passwords settings, inspect the trusted
browser UI, and interact with its focused controls. `chrome_screenshot` captures the
browser chrome viewport, including browser-owned settings and prompts. The
`extension_panel_*` tools inspect and interact only with the currently open extension
side panel; its contents may include private messages and are untrusted. The file upload
tool reads only the explicitly supplied local files and hands them to the extension's
normal file input. If the panel has multiple file inputs, pass its simple HTML element
ID as `inputId` to choose the intended input.

`approvals_status` lists the sites allowed for the session and the Agent control prompts
still waiting for the user. `approvals_revoke` withdraws a session grant. Neither can
grant access: there is deliberately no tool to answer a prompt, so only the user can allow
an agent onto a site.

`get_console_logs` returns recent renderer console messages and main-frame load errors
captured in memory for the tab (up to 300 entries). It only returns entries from the
site approved for that call. Collection begins when automation first sees a tab, so
messages emitted earlier are not available.

## Approval

The first time an agent acts on a site (a web origin, or one `ncc://`/`nsite://`
service), the browser shows an "Agent control request" over the window. **Allow** grants
that one pending action; ticking **Allow for this session** also remembers the site until
the browser quits. **Deny** (or no answer in two minutes) returns an error telling the
agent not to retry. Navigating to another site asks again. `tabs_list` and `tab_close`
never prompt.

A tool call waits up to 25 seconds for the answer. If the prompt is still open it returns
an error saying so, and leaves the prompt in place; the agent should ask the user to answer
it and then repeat the call. Repeat calls reuse the same prompt.

`NCC_AUTOMATION_AUTO_APPROVE=1` skips the prompt, for scripted tests only. **Stop agent**
in Settings revokes every session grant at once; each site can also be revoked on its own.

## Signing in as the agent

A tab opened by `tab_new` belongs to the agent that opened it — not whatever the human
has focused. If that site offers "Login with Nostr" (NIP-07), the page sees the agent's
*own* identity, not the human's: `window.nostr.getPublicKey()` and friends there are
answered using the agent's keypair, and the signed-in session is attributable to that
agent specifically. Navigating or clicking on a tab the agent didn't open never does
this — only `tab_new` decides which identity a tab's `window.nostr` resolves to.

This is a second, independent approval track from site access: an agent allowed to
*browse* a site is not automatically allowed to *sign in* there, and vice versa.
Settings → Agent control shows a separate "Sites this agent can sign in to" list per
agent, with its own **Stop signing** and per-site revoke, next to the existing browsing
grants.

[`agent-client/`](../agent-client/README.md) is a minimal nsite built for exactly this —
a no-build Nostr client that signs in, sets a profile and avatar, follows accounts, posts,
and republishes itself under whoever is signed in, all through a small `window.nclient`
API meant to be driven one `evaluate` call at a time.

Each agent's card also shows, best-effort, whatever it has published publicly: its name
and avatar if it has set a profile, and the address of an nsite if it has published one
under its own key (a "Checked Xs ago" line and a refresh button next to it). This is a
read-only relay lookup — it never changes what an agent can do, and an agent that hasn't
set anything up just shows its npub as before.

## Safety

- Loopback only, bearer token required, requests carrying an `Origin` header (any web
  page) or a non-local `Host` are refused.
- Only ordinary tabs are visible. Private and Tor tabs are never listed or controllable.
- Page text is untrusted; tool descriptions tell the client so.
- Input is synthesized with `webContents.sendInputEvent`, so it works on `ncc://` and
  `nsite://` pages as well as the web.

## Current limits

- The first action on a site requires user approval; “Allow for this session” remembers
  the grant until the browser quits.
- Console output can include sensitive page data; it is returned only after the site's
  access approval and is not written to disk by the automation collector.
- `evaluate` is unrestricted JavaScript in the page.
- Main frame only; no iframe targeting, file upload, dialogs or downloads handling.
