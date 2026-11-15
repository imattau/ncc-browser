import { ERROR_COPY } from '@shared/types'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface ErrorPageOptions {
  code: string
  message?: string
  detail?: string
  address?: string
}

/**
 * A self-contained failure screen served by the ncc:// handler. Keeping it inline
 * means a broken resolver never depends on the renderer or any remote asset.
 */
export function renderErrorPage(options: ErrorPageOptions): string {
  const copy = ERROR_COPY[options.code] ?? {
    title: 'Resolution failed',
    hint: 'The address could not be resolved.'
  }
  const address = options.address ? escapeHtml(options.address) : ''
  const message = options.message && options.message !== copy.title ? escapeHtml(options.message) : ''
  const detail = options.detail ? escapeHtml(options.detail) : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${escapeHtml(copy.title)} — NCC</title>
<style>
  :root {
    --bg: #0b0c10;
    --panel: #14161d;
    --border: #262a36;
    --text: #e7e9ef;
    --muted: #9aa3b2;
    --danger: #ff7a7a;
    --accent: #8ab4ff;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background:
      radial-gradient(1100px 500px at 50% -10%, rgba(138, 180, 255, 0.16), transparent 60%),
      var(--bg);
    color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: grid;
    place-items: center;
    padding: 32px;
  }
  .card {
    width: min(640px, 100%);
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 32px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    letter-spacing: 0.02em;
    color: var(--danger);
    background: rgba(255, 122, 122, 0.1);
    border: 1px solid rgba(255, 122, 122, 0.25);
    border-radius: 999px;
    padding: 6px 12px;
  }
  h1 {
    font-size: 26px;
    line-height: 1.2;
    margin: 18px 0 12px;
    letter-spacing: -0.02em;
  }
  p { color: var(--muted); line-height: 1.6; margin: 0 0 16px; }
  .message { color: var(--text); font-weight: 500; }
  .address {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px;
    color: var(--accent);
    background: rgba(138, 180, 255, 0.08);
    border: 1px solid rgba(138, 180, 255, 0.18);
    border-radius: 10px;
    padding: 10px 12px;
    overflow-wrap: anywhere;
    margin-bottom: 20px;
  }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 24px; }
  a.button {
    appearance: none;
    text-decoration: none;
    font-size: 14px;
    font-weight: 600;
    color: #0b0c10;
    background: var(--accent);
    border-radius: 10px;
    padding: 10px 16px;
  }
  a.button.secondary {
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
  }
  details {
    margin-top: 22px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
    color: var(--muted);
    font-size: 13px;
  }
  summary { cursor: pointer; user-select: none; }
  pre {
    margin: 12px 0 0;
    padding: 12px;
    background: #0d0f15;
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: #c8cfdb;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  footer {
    margin-top: 26px;
    font-size: 12px;
    color: #6d7585;
  }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">NCC-05 · ${escapeHtml(options.code)}</span>
    <h1>${escapeHtml(copy.title)}</h1>
    ${message ? `<p class="message">${message}</p>` : ''}
    <p>${escapeHtml(copy.hint)}</p>
    ${address ? `<div class="address">${address}</div>` : ''}
    <div class="actions">
      ${address ? `<a class="button" href="${address}">Try again</a>` : ''}
      <a class="button secondary" href="https://github.com/imattau/nostr-community-conventions/blob/master/ncc-05/README.md">NCC-05 spec</a>
    </div>
    ${detail ? `<details><summary>Technical detail</summary><pre>${detail}</pre></details>` : ''}
    <footer>Resolved without DNS. The npub signature and record TTL are the only trust anchors.</footer>
  </main>
</body>
</html>`
}

export function renderPlainFailure(code: string, message: string): string {
  return `NCC resolution failed (${code}): ${message}`
}

export interface HttpWarningOptions {
  address: string
  host: string
  service: string
  mode: 'off' | 'prefer' | 'only'
  continueUrl: string
}

/** Interstitial for an NCC service that would be fetched over plaintext HTTP. */
export function renderHttpWarningPage(options: HttpWarningOptions): string {
  const only = options.mode === 'only'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${only ? 'HTTPS required' : 'Not secure'} — NCC</title>
<style>
  :root { --bg:#0b0c10; --panel:#14161d; --line:#262a36; --text:#e7e9ef; --muted:#9aa3b2; --warn:#ffcc66; --accent:#8ab4ff; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; background:radial-gradient(1000px 460px at 50% -10%, rgba(255,204,102,0.13), transparent 60%), var(--bg); color:var(--text); font-family:ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display:grid; place-items:center; padding:32px; }
  .card { width:min(620px,100%); background:color-mix(in srgb, var(--panel) 90%, transparent); border:1px solid var(--line); border-radius:18px; padding:32px; box-shadow:0 24px 80px rgba(0,0,0,.45); }
  .badge { display:inline-flex; gap:8px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:var(--warn); background:rgba(255,204,102,.1); border:1px solid rgba(255,204,102,.28); border-radius:999px; padding:6px 12px; }
  h1 { margin:18px 0 10px; font-size:27px; letter-spacing:-.02em; }
  p { margin:10px 0; color:var(--muted); font-size:14px; line-height:1.55; }
  .address { margin-top:16px; padding:12px; background:#0d0f15; border:1px solid var(--line); border-radius:10px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:#c8cfdb; overflow-wrap:anywhere; }
  .actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:24px; }
  a.button { display:inline-flex; align-items:center; padding:10px 16px; border-radius:9px; background:var(--accent); color:#0b0c10; font-weight:650; font-size:13px; text-decoration:none; }
  a.button.secondary { background:transparent; border:1px solid var(--line); color:var(--text); font-weight:500; }
  footer { margin-top:24px; color:#6d7585; font-size:12px; }
</style>
</head>
<body>
  <main class="card">
    <span class="badge">NCC-05 · ${only ? 'HTTPS required' : 'plaintext HTTP'}</span>
    <h1>${only ? 'This service does not offer HTTPS' : 'This connection is not secure'}</h1>
    <p>${only
      ? 'HTTPS-only is enabled, so this service would be fetched over plaintext HTTP. Continue only if you trust the destination.'
      : 'This service is fetched over plaintext HTTP. Anyone on the network can read or modify the page.'}</p>
    <p><strong>${escapeHtml(options.service)}</strong> · ${escapeHtml(options.host)}</p>
    <div class="address">${escapeHtml(options.address)}</div>
    <div class="actions">
      <a class="button" href="${escapeHtml(options.continueUrl)}">Continue over HTTP</a>
      <a class="button secondary" href="#" onclick="history.back(); return false">Go back</a>
    </div>
    <footer>The npub signature protects the locator, not the page content. HTTP has no TLS layer.</footer>
  </main>
</body>
</html>`
}
