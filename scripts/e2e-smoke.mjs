#!/usr/bin/env node
/**
 * End-to-end smoke test: mock relay + local HTTP service + real Electron window,
 * driven over the Chrome DevTools Protocol.
 *
 * Proves the whole chain: ncc:// address → relay query (kind 30058) → payload parse →
 * endpoint fetch → subresource proxying → rendered page. Then proves a failure case
 * renders the distinct error page.
 *
 * Run: npm run e2e
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const ROOT = new URL('..', import.meta.url).pathname
const ARTIFACTS = '/tmp/opencode/ncc-browser-e2e'

const serviceSk = generateSecretKey()
const servicePk = getPublicKey(serviceSk)
const serviceNpub = nip19.npubEncode(servicePk)
const missingSk = generateSecretKey()
const missingNpub = nip19.npubEncode(getPublicKey(missingSk))

const relayEvents = []

function matches(filters, event) {
  return filters.some((filter) => {
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false
    for (const [key, values] of Object.entries(filter)) {
      if (!key.startsWith('#')) continue
      const tagName = key.slice(1)
      const tagValues = event.tags.filter((tag) => tag[0] === tagName).map((tag) => tag[1])
      if (!values.some((value) => tagValues.includes(value))) return false
    }
    return true
  })
}

async function startRelay() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      const [verb, ...rest] = message
      if (verb === 'REQ') {
        const [subId, ...filters] = rest
        for (const event of relayEvents) {
          if (matches(filters, event)) socket.send(JSON.stringify(['EVENT', subId, event]))
        }
        socket.send(JSON.stringify(['EOSE', subId]))
      }
      if (verb === 'EVENT') {
        const event = rest[0]
        relayEvents.push(event)
        socket.send(JSON.stringify(['OK', event.id, true, '']))
      }
      if (verb === 'CLOSE') {
        // stateless mock: nothing to clean up
      }
    })
  })

  return { wss, port: wss.address().port }
}

async function startService() {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>NCC E2E</title>
<link rel="stylesheet" href="/style.css"></head>
<body><h1 id="headline">NCC E2E OK</h1>
<p id="proxied">resolved-and-proxied</p>
<a id="next" href="second">second</a></body></html>`

  const server = createServer((request, response) => {
    if (request.url === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css' })
      response.end('body { background-color: rgb(12, 34, 56); }')
      return
    }
    if (request.url === '/second') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Second</title><h1 id="second">SECOND PAGE</h1>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(html)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

function publishLocator(port) {
  const content = JSON.stringify({
    v: 1,
    ttl: 3600,
    updated_at: Math.floor(Date.now() / 1000),
    endpoints: [{ type: 'http', uri: `127.0.0.1:${port}`, priority: 1, family: 'ipv4' }]
  })
  const event = finalizeEvent(
    {
      kind: 30058,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'web']],
      content
    },
    serviceSk
  )
  relayEvents.push(event)
  return event
}

async function fetchJson(url, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${url}`)
}

class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.socket = null
  }

  async connect() {
    this.socket = new WebSocket(this.url, { perMessageDeflate: false })
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket?.close()
  }
}

async function waitForTarget(predicate, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const targets = await fetchJson('http://127.0.0.1:9333/json/list')
    const match = targets.find(predicate)
    if (match) return match
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('content target never appeared')
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? 'evaluation failed')
  }
  return result.result.value
}

async function waitForText(cdp, needle, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const text = await evaluate(cdp, 'document.body ? document.body.innerText : ""')
    if (typeof text === 'string' && text.includes(needle)) return text
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const text = await evaluate(cdp, 'document.body ? document.body.innerText : ""')
  throw new Error(`never found ${JSON.stringify(needle)} in: ${text}`)
}

const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`)
  } else {
    console.log(`  FAIL  ${name} ${detail}`)
    failures.push(name)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startXvfb() {
  const display = `:${90 + (process.pid % 50)}`
  const proc = spawn('Xvfb', [display, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore'
  })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) return { display, proc }
    await sleep(100)
  }
  throw new Error('Xvfb did not start')
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true })

  const { wss, port: relayPort } = await startRelay()
  const { server, port: servicePort } = await startService()
  const event = publishLocator(servicePort)
  console.log(`relay ws://127.0.0.1:${relayPort} · service http://127.0.0.1:${servicePort}`)
  console.log(`npub ${serviceNpub} · locator ${event.id.slice(0, 12)}…`)

  const configHome = mkdtempSync(join(tmpdir(), 'ncc-e2e-'))
  const userData = join(configHome, 'NCC Browser')
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'config.json'),
    `${JSON.stringify({ relays: [`ws://127.0.0.1:${relayPort}`] }, null, 2)}\n`
  )

  const xvfb = await startXvfb()

  const electron = spawn(
    join(ROOT, 'node_modules/.bin/electron'),
    [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=9333',
      '--remote-allow-origins=*',
      `ncc://${serviceNpub}/web/`
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        XDG_CONFIG_HOME: configHome,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  let logs = ''
  electron.stdout.on('data', (chunk) => {
    logs += chunk.toString()
  })
  electron.stderr.on('data', (chunk) => {
    logs += chunk.toString()
  })

  const cleanup = () => {
    electron.kill('SIGTERM')
    xvfb.proc.kill('SIGTERM')
    server.close()
    wss.close()
  }

  try {
    const target = await waitForTarget((entry) => entry.url?.startsWith('ncc://'))
    console.log(`content target ${target.url}`)

    const cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.connect()

    const text = await waitForText(cdp, 'NCC E2E OK', 80)
    check('renders the resolved page', text.includes('NCC E2E OK'))
    check('proxies absolute-path subresources', text.includes('resolved-and-proxied'))

    const background = await evaluate(cdp, 'getComputedStyle(document.body).backgroundColor')
    check('subresource CSS applied', background === 'rgb(12, 34, 56)', `(got ${background})`)

    const href = await evaluate(cdp, 'document.querySelector("#next")?.href ?? ""')
    check(
      'relative links resolve inside the service',
      String(href) === `ncc://${serviceNpub}/web/second`,
      String(href)
    )

    const location = await evaluate(cdp, 'location.href')
    check(
      'document URL keeps the service namespace',
      String(location) === `ncc://${serviceNpub}/web/`,
      String(location)
    )

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'resolved.png'), Buffer.from(screenshot.data, 'base64'))

    // Inspect the trusted chrome renderer: address bar, security state.
    const chromeTarget = await waitForTarget((entry) => entry.url?.includes('/renderer/index.html'))
    const chrome = new Cdp(chromeTarget.webSocketDebuggerUrl)
    await chrome.connect()

    const address = await evaluate(
      chrome,
      'document.querySelector(\'input[aria-label="Address"]\')?.value ?? ""'
    )
    check('address bar shows the ncc address', String(address).includes(serviceNpub), String(address))

    const chromeText = await evaluate(chrome, 'document.body.innerText')
    check('toolbar reports plaintext transport', String(chromeText).includes('plaintext'), String(chromeText))

    await sleep(400)
    const chromeShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'chrome.png'), Buffer.from(chromeShot.data, 'base64'))

    // Failure case: a different pubkey with no locator at all.
    await cdp.send('Page.navigate', { url: `ncc://${missingNpub}/web/` })
    const errorText = await waitForText(cdp, 'No locator published', 80)
    check('renders the no-record error page', errorText.includes('No locator published'))
    check('error page names the code', errorText.includes('no-record'))

    await sleep(400)
    const chromeErrorText = await evaluate(chrome, 'document.body.innerText')
    check('toolbar surfaces the failure code', String(chromeErrorText).includes('no-record'), String(chromeErrorText))

    const errorShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'no-record.png'), Buffer.from(errorShot.data, 'base64'))

    cdp.close()
    chrome.close()
  } finally {
    cleanup()
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`)
    if (logs.trim()) console.error(`\n--- electron output ---\n${logs.slice(-4000)}`)
    process.exitCode = 1
    return
  }

  console.log(`\nPASS · screenshots in ${ARTIFACTS}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
