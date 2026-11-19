# Agent automation (prototype)

Nostr Navigator can expose its tabs to a local MCP client such as Claude Code or Codex.
This is off by default. The browser hosts the MCP server itself, so no extension is
involved.

## Enable

**Settings → Agent control → Allow agent control.** The server listens on
`127.0.0.1:47821` (a free port if that is taken) and the page shows a ready-made
command. Click **Copy command**, then run it once in a terminal:

```bash
claude mcp add --transport http ncc-browser http://127.0.0.1:47821/mcp \
  --header "Authorization: Bearer <token>"
```

The token is created once, stored in `automation-settings.json` in the profile (mode
0600) and survives restarts, so the connection is made only once. **Regenerate token**
disconnects every existing client. Turning the setting off stops the server.

Developers: `NCC_AUTOMATION=1` forces the server on, `NCC_AUTOMATION_PORT` pins the
port, and the current `{ url, token }` is written to `automation.json` while it runs.
To try it without touching your real profile use a scratch config home:

```bash
XDG_CONFIG_HOME=/tmp/ncc-scratch NCC_AUTOMATION=1 npm run dev
```

## Tools

`tabs_list`, `tab_new`, `tab_close`, `navigate`, `read_page` (numbered interactive
elements), `get_page_text`, `get_console_logs`, `screenshot`, `click`, `hover`, `type`,
`press_key`, `scroll`, `evaluate`, `approvals_status`, `approvals_revoke`.

Browser development tools are a separate permission scope, independent of site access.
The first `open_settings`, `chrome_read_page`, `chrome_screenshot`, `chrome_click`,
`chrome_type` or `chrome_press_key` call shows the same Agent control popup, identifying
the request as browser development access. A session grant for this scope does not grant
access to any website, and site grants do not grant access to browser settings. The
chrome tools can open General, Identity, and Passwords settings, inspect the trusted
browser UI, and interact with its focused controls. `chrome_screenshot` captures the
browser chrome viewport, including browser-owned settings and prompts.

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
