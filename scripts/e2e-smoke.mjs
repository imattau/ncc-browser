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

import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip19,
  nip44,
  verifyEvent
} from 'nostr-tools'
import selfsigned from 'selfsigned'

const ROOT = new URL('..', import.meta.url).pathname
const ARTIFACTS = '/tmp/opencode/ncc-browser-e2e'

const serviceSk = generateSecretKey()
const servicePk = getPublicKey(serviceSk)
const serviceNpub = nip19.npubEncode(servicePk)
const missingSk = generateSecretKey()
const missingNpub = nip19.npubEncode(getPublicKey(missingSk))
const signerSk = generateSecretKey()
const signerPk = getPublicKey(signerSk)
const signerNpub = nip19.npubEncode(signerPk)
const peerPk = getPublicKey(generateSecretKey())

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
  const events = []
  const sockets = new Set()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))

  wss.on('connection', (socket) => {
    const subs = []
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))

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
        if (filters.some((filter) => filter?.kinds?.includes(24133))) {
          console.log(`  relay REQ 24133 ${JSON.stringify(filters)}`)
        }
        subs.push({ subId, filters })
        for (const event of events) {
          if (matches(filters, event)) socket.send(JSON.stringify(['EVENT', subId, event]))
        }
        socket.send(JSON.stringify(['EOSE', subId]))
      }
      if (verb === 'CLOSE') {
        const index = subs.findIndex((sub) => sub.subId === rest[0])
        if (index !== -1) subs.splice(index, 1)
      }
      if (verb === 'EVENT') {
        const event = rest[0]
        if (event.kind === 24133) console.log(`  relay EVENT 24133 ${JSON.stringify(event.tags)}`)
        events.push(event)
        socket.send(JSON.stringify(['OK', event.id, true, '']))
        for (const peer of sockets) {
          for (const sub of peer.subs ?? []) {
            if (matches(sub.filters, event)) {
              peer.send(JSON.stringify(['EVENT', sub.subId, event]))
            }
          }
        }
      }
    })

    socket.subs = subs
  })

  return { wss, port: wss.address().port, events }
}

async function startService(npub) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>NCC E2E</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css"></head>
<body><h1 id="headline">NCC E2E OK</h1>
<p id="proxied">resolved-and-proxied</p>
<a id="next" href="second">second</a>
<a id="download" href="/sample.txt" download="sample.txt">download</a>
<a id="cross" href="ncc://${npub}/_/secure/">secure service</a></body></html>`

  const server = createServer((request, response) => {
    if (request.url === '/style.css') {
      response.writeHead(200, { 'content-type': 'text/css' })
      response.end('body { background-color: rgb(12, 34, 56); }')
      return
    }
    if (request.url === '/favicon.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml' })
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#8ab4ff"/></svg>'
      )
      return
    }
    if (request.url === '/sample.txt') {
      response.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="sample.txt"'
      })
      response.end('ncc download e2e\n')
      return
    }
    if (request.url === '/second') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Second</title><h1 id="second">SECOND PAGE</h1>')
      return
    }
    if (request.url === '/hinted') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Hinted</title><h1 id="hinted">HINTED OK</h1>')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(html)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

async function startPublisher() {
  const root = join(ROOT, 'publisher', 'dist')
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error('publisher/dist is missing; run npm run publisher:build')
  }

  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.woff2': 'font/woff2'
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/index.html'
    const file = join(root, pathname)
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    response.end(readFileSync(file))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

function publishLocator(relay, d, endpoints) {
  const content = JSON.stringify({
    v: 1,
    ttl: 3600,
    updated_at: Math.floor(Date.now() / 1000),
    endpoints
  })
  const event = finalizeEvent(
    {
      kind: 30058,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', d]],
      content
    },
    serviceSk
  )
  relay.events.push(event)
  return event
}

function publishRelayList(relay, hintRelayUrl) {
  const event = finalizeEvent(
    {
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['r', hintRelayUrl]],
      content: ''
    },
    serviceSk
  )
  relay.events.push(event)
  return event
}

function publishEncryptedLocator(relay, d, endpoints, recipientPk) {
  const payload = JSON.stringify({
    v: 1,
    ttl: 3600,
    updated_at: Math.floor(Date.now() / 1000),
    endpoints
  })
  const key = nip44.getConversationKey(serviceSk, recipientPk)
  const event = finalizeEvent(
    {
      kind: 30058,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', d]],
      content: nip44.encrypt(payload, key)
    },
    serviceSk
  )
  relay.events.push(event)
  return event
}

function publishAnchor(relay, d, { u, k, exp } = {}) {
  const tags = [['d', d], ['exp', String(exp ?? Math.floor(Date.now() / 1000) + 3600)]]
  if (u) tags.push(['u', u])
  if (k) tags.push(['k', k])
  const event = finalizeEvent(
    {
      kind: 30059,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    },
    serviceSk
  )
  relay.events.push(event)
  return event
}

/**
 * Minimal NIP-46 bunker for the e2e run: subscribes to kind 24133 requests addressed
 * to it, decrypts them, and answers connect / get_public_key / sign_event / nip44*.
 */
function startBunker(relayUrl, bunkerSk) {
  const bunkerPk = getPublicKey(bunkerSk)
  const pool = new SimplePool()
  let signRequests = 0
  let decryptRequests = 0

  const respond = async (clientPk, id, payload) => {
    const key = nip44.getConversationKey(bunkerSk, clientPk)
    const event = finalizeEvent(
      {
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', clientPk]],
        content: nip44.encrypt(JSON.stringify({ id, ...payload }), key)
      },
      bunkerSk
    )
    await pool.publish([relayUrl], event)
  }

  const handle = async (event) => {
    let request
    try {
      const key = nip44.getConversationKey(bunkerSk, event.pubkey)
      request = JSON.parse(nip44.decrypt(event.content, key))
    } catch {
      return
    }
    console.log(`  bunker <- ${request.method}`)

    const params = request.params ?? []
    try {
      switch (request.method) {
        case 'connect':
          await respond(event.pubkey, request.id, { result: params[1] ?? 'ack' })
          break
        case 'get_public_key':
          await respond(event.pubkey, request.id, { result: bunkerPk })
          break
        case 'ping':
          await respond(event.pubkey, request.id, { result: 'pong' })
          break
        case 'sign_event': {
          signRequests += 1
          const signed = finalizeEvent(JSON.parse(params[0]), bunkerSk)
          await respond(event.pubkey, request.id, { result: JSON.stringify(signed) })
          break
        }
        case 'nip44_encrypt': {
          const key = nip44.getConversationKey(bunkerSk, params[0])
          await respond(event.pubkey, request.id, { result: nip44.encrypt(params[1], key) })
          break
        }
        case 'nip44_decrypt': {
          decryptRequests += 1
          const key = nip44.getConversationKey(bunkerSk, params[0])
          await respond(event.pubkey, request.id, { result: nip44.decrypt(params[1], key) })
          break
        }
        case 'nip04_encrypt': {
          const key = nip04.encrypt(bunkerSk, params[0], params[1])
          await respond(event.pubkey, request.id, { result: key })
          break
        }
        case 'nip04_decrypt': {
          const key = nip04.decrypt(bunkerSk, params[0], params[1])
          await respond(event.pubkey, request.id, { result: key })
          break
        }
        default:
          await respond(event.pubkey, request.id, { error: `unsupported method ${request.method}` })
      }
    } catch (error) {
      await respond(event.pubkey, request.id, {
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined)
    }
  }

  const sub = pool.subscribeMany(
    [relayUrl],
    { kinds: [24133], '#p': [bunkerPk] },
    {
      onevent: (event) => {
        void handle(event)
      }
    }
  )

  return {
    bunkerPk,
    signRequests: () => signRequests,
    decryptRequests: () => decryptRequests,
    close: () => {
      sub.close()
      pool.close([relayUrl])
    }
  }
}

async function startSecureService(host, cert, key, headline) {
  const server = createHttpsServer({ cert, key }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><title>secure</title><h1 id="headline">${headline}</h1>`)
  })
  await new Promise((resolve) => server.listen(0, host, resolve))
  return { server, port: server.address().port }
}

function spkiFingerprint(pem) {
  const spki = createPublicKey(pem).export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('base64url')
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

async function waitForTarget(predicate, attempts = 80, port = 9333) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
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
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluation failed'
    )
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

async function evaluateNoAwait(cdp, expression) {
  return cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false
  })
}

async function waitForValue(cdp, expression, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await evaluate(cdp, expression)
    if (value !== undefined && value !== null && value !== '') return value
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for ${expression}`)
}

async function readSecurity(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('[data-security-button]')
      if (!button) return null
      return {
        tone: button.getAttribute('data-security-tone'),
        label: button.getAttribute('data-security-label'),
        anchor: button.getAttribute('data-anchor-state')
      }
    })()`
  )
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

function xdotool(display, args) {
  return spawnSync('xdotool', args, {
    env: { ...process.env, DISPLAY: display },
    encoding: 'utf8'
  })
}

function findElectronWindow(display) {
  const result = xdotool(display, ['search', '--onlyvisible', '--name', 'NCC Browser'])
  if (result.status !== 0) return null
  return result.stdout.trim().split('\n').filter(Boolean)[0] ?? null
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true })

  const relayA = await startRelay()
  const relayB = await startRelay()
  const { server, port: servicePort } = await startService(serviceNpub)
  const publisher = await startPublisher()

  // Two HTTPS services on different loopback addresses: one presents the pinned
  // certificate, the other presents a different one while claiming the same `k`.
  const goodCert = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    notAfterDate: new Date(Date.now() + 2 * 86_400_000),
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]
  })
  const badCert = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.2' }], {
    notAfterDate: new Date(Date.now() + 2 * 86_400_000),
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.2' }] }]
  })
  const pinnedK = spkiFingerprint(goodCert.cert)
  const secure = await startSecureService('127.0.0.1', goodCert.cert, goodCert.private, 'SECURE OK')
  const bogus = await startSecureService('127.0.0.2', badCert.cert, badCert.private, 'BOGUS OK')

  const event = publishLocator(relayA, 'web', [
    { type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' }
  ])
  publishLocator(relayA, 'secure', [
    { type: 'https', uri: `127.0.0.1:${secure.port}`, priority: 1, family: 'ipv4', k: pinnedK }
  ])
  publishLocator(relayA, 'bogus', [
    { type: 'https', uri: `127.0.0.2:${bogus.port}`, priority: 1, family: 'ipv4', k: pinnedK }
  ])
  // NCC-02 anchors: one public service with a matching key, and one service that only
  // has a `u` endpoint (no NCC-05 locator) to exercise the anchored fallback.
  publishAnchor(relayA, 'secure', { u: `https://127.0.0.1:${secure.port}`, k: pinnedK })
  publishAnchor(relayA, 'ncc02only', { u: `http://127.0.0.1:${servicePort}` })
  // `hinted` only exists on relay B; relay A holds the NIP-65 list pointing there.
  publishRelayList(relayA, `ws://127.0.0.1:${relayB.port}`)
  publishLocator(relayB, 'hinted', [
    { type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' }
  ])

  console.log(`relay A ws://127.0.0.1:${relayA.port} · relay B ws://127.0.0.1:${relayB.port}`)
  console.log(`service http://127.0.0.1:${servicePort}`)
  console.log(`publisher http://127.0.0.1:${publisher.port}`)
  console.log(`pinned https://127.0.0.1:${secure.port} · k ${pinnedK.slice(0, 12)}…`)
  console.log(`npub ${serviceNpub} · locator ${event.id.slice(0, 12)}…`)

  const configHome = mkdtempSync(join(tmpdir(), 'ncc-e2e-'))
  const userData = join(configHome, 'NCC Browser')
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'config.json'),
    `${JSON.stringify({ relays: [`ws://127.0.0.1:${relayA.port}`], gossip: true }, null, 2)}\n`
  )

  const xvfb = await startXvfb()

  const electron = spawn(
    join(ROOT, 'node_modules/.bin/electron'),
    [
      '.',
      '--no-sandbox',
      '--disable-gpu',
      '--ozone-platform=x11',
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
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        NCC_IDENTITY_NSEC: nip19.nsecEncode(signerSk),
        NCC_NIP46_TIMEOUT_MS: '15000',
        NCC_DOWNLOAD_DIR: join(configHome, 'downloads')
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

  let bunker = null
  let restarted = null

  const cleanup = () => {
    bunker?.close()
    electron.kill('SIGTERM')
    restarted?.kill('SIGTERM')
    xvfb.proc.kill('SIGTERM')
    server.close()
    publisher.server.close()
    secure.server.close()
    bogus.server.close()
    relayA.wss.close()
    relayB.wss.close()
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
      String(href) === `ncc://${serviceNpub}/_/web/second`,
      String(href)
    )

    const location = await evaluate(cdp, 'location.href')
    check(
      'document URL keeps the service namespace',
      String(location) === `ncc://${serviceNpub}/_/web/`,
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
    check(
      'address bar shows the clean ncc address',
      String(address) === `ncc://${serviceNpub}/web/`,
      String(address)
    )
    check('address bar hides the internal service prefix', !String(address).includes('/_/'), String(address))

    const initialSecurity = await readSecurity(chrome)
    check(
      'security lock reports plaintext',
      initialSecurity?.label === 'plaintext' && initialSecurity?.tone === 'warn',
      JSON.stringify(initialSecurity)
    )
    check(
      'security lock shows an unanchored dot',
      initialSecurity?.anchor === 'unanchored',
      JSON.stringify(initialSecurity)
    )

    // The site information panel explains what anchoring would add.
    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    check(
      'opens the site information panel',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-popover=site-info]"))')) === true
    )
    check(
      'site info explains the missing anchor',
      (await evaluate(chrome, 'document.body.innerText')).includes('No NCC-02 service record')
    )
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Site information"]\').click()')
    await sleep(250)

    // Favicons are fetched in main and handed to the chrome as data URLs.
    const favicon = await waitForValue(
      chrome,
      'document.querySelector(\'[role="tab"] img\')?.getAttribute("src") ?? ""',
      80
    )
    check(
      'shows the page favicon in the tab strip',
      String(favicon).startsWith('data:image/svg+xml'),
      String(favicon).slice(0, 40)
    )

    // Settings is a page in the chrome, not a modal dialog.
    await evaluate(chrome, 'document.querySelector(\'button[data-signer-button]\').click()')
    await waitForText(chrome, 'Remote signer', 60)
    const settingsShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'settings.png'), Buffer.from(settingsShot.data, 'base64'))
    check(
      'opens settings as a full page',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-settings-page]"))')) === true
    )
    check(
      'settings page keeps the tab strip available',
      (await evaluate(chrome, 'document.querySelectorAll(\'[role="tab"]\').length')) === 1
    )
    await evaluate(chrome, 'document.querySelector(\'[data-settings-section="general"]\').click()')
    await waitForText(chrome, 'Relays & resolution', 40)
    check(
      'settings page switches sections',
      (await evaluate(chrome, 'Boolean(document.querySelector("#relays"))')) === true
    )
    check(
      'settings page exposes NCC-02 anchoring',
      (await evaluate(chrome, 'Boolean(document.querySelector("#anchor-required"))')) === true
    )
    const generalShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'settings-general.png'), Buffer.from(generalShot.data, 'base64'))
    await evaluate(chrome, 'document.querySelector(\'[data-settings-page] header button\').click()')
    await sleep(350)
    check(
      'closes settings back to the page',
      (await evaluate(chrome, 'document.querySelector("[data-settings-page]") === null')) === true
    )

    // Downloads: the content page triggers a real session download.
    await evaluate(cdp, 'document.querySelector("#download").click()')
    await waitForValue(
      chrome,
      'document.querySelector("[data-downloads-button]") ? "shown" : ""',
      80
    )
    const downloadedFile = join(configHome, 'downloads', 'sample.txt')
    let downloaded = false
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (existsSync(downloadedFile)) {
        downloaded = true
        break
      }
      await sleep(150)
    }
    check('downloads a file through the content session', downloaded)

    await evaluate(chrome, 'document.querySelector("[data-downloads-button]").click()')
    await waitForText(chrome, 'sample.txt', 40)
    check(
      'opens the downloads panel',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-popover=downloads]"))')) === true
    )
    check(
      'download list offers reveal in folder',
      (await evaluate(
        chrome,
        'Boolean(document.querySelector(\'button[aria-label="Show sample.txt in folder"]\'))'
      )) === true
    )
    const downloadsShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'downloads.png'), Buffer.from(downloadsShot.data, 'base64'))
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Downloads"]\').click()')
    await sleep(250)

    // NIP-07: the identity lives in the main process and is exposed to page content only.
    const identityStatus = await evaluate(chrome, 'window.ncc.identity()')
    check(
      'identity is available to the chrome UI',
      identityStatus?.configured === true && identityStatus?.source === 'env',
      JSON.stringify(identityStatus)
    )
    check(
      'chrome renderer has no nostr provider',
      (await evaluate(chrome, 'typeof window.nostr')) === 'undefined'
    )

    // First NIP-07 call must show the in-app approval sheet.
    await evaluateNoAwait(
      cdp,
      `window.nostr.getPublicKey()
        .then((value) => { window.__nip07Pub = value })
        .catch((error) => { window.__nip07Error = String(error) })`
    )

    await waitForText(chrome, 'Signer request', 80)
    check(
      'shows an in-app signer prompt',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-signer-prompt]"))')) === true
    )
    check(
      'focus stays inside the signer prompt',
      (await evaluate(
        chrome,
        'document.activeElement?.hasAttribute("data-signer-deny") === true'
      )) === true
    )

    const approvalShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'approval.png'), Buffer.from(approvalShot.data, 'base64'))

    await evaluate(
      chrome,
      `(() => {
        const remember = document.querySelector('[data-signer-remember]')
        if (remember && !remember.checked) remember.click()
        document.querySelector('[data-signer-allow]').click()
        return true
      })()`
    )

    const approvedPub = await waitForValue(cdp, 'window.__nip07Pub')
    check('approval unblocks the NIP-07 call', approvedPub === signerPk, String(approvedPub))
    await sleep(300)
    check(
      'signer prompt closes after approval',
      (await evaluate(chrome, 'document.querySelector("[data-signer-prompt]") === null')) === true
    )

    const nip07 = await evaluate(
      cdp,
      `(async () => {
        const pub = await window.nostr.getPublicKey()
        const event = await window.nostr.signEvent({
          kind: 1,
          created_at: ${Math.floor(Date.now() / 1000)},
          tags: [],
          content: 'nip07 e2e'
        })
        const peer = '${peerPk}'
        const wrapped = await window.nostr.nip44.encrypt(peer, 'secret message')
        const plain = await window.nostr.nip44.decrypt(peer, wrapped)
        const legacy = await window.nostr.nip04.encrypt(peer, 'legacy')
        const legacyPlain = await window.nostr.nip04.decrypt(peer, legacy)
        const frame = document.createElement('iframe')
        frame.srcdoc = '<html><body>frame</body></html>'
        document.body.appendChild(frame)
        await new Promise((resolve) => { frame.onload = resolve })
        const iframeHasNostr = typeof frame.contentWindow.nostr !== 'undefined'
        frame.remove()
        return { pub, event, plain, legacyPlain, iframeHasNostr }
      })()`
    )
    check('NIP-07 exposes the configured public key', nip07.pub === signerPk, String(nip07.pub))
    check(
      'NIP-07 signs a verifiable event',
      verifyEvent(nip07.event) === true && nip07.event.pubkey === signerPk
    )
    check('NIP-44 round-trips through the signer', nip07.plain === 'secret message')
    check('NIP-04 round-trips through the signer', nip07.legacyPlain === 'legacy')
    check('NIP-07 is not exposed to subframes', nip07.iframeHasNostr === false)

    // NIP-46: a mock bunker over the same relay. First publish a locator encrypted to
    // the remote signer, so resolution itself must go through the remote signer.
    const bunkerKey = generateSecretKey()
    bunker = startBunker(`ws://127.0.0.1:${relayA.port}`, bunkerKey)
    const bunkerNpub = nip19.npubEncode(bunker.bunkerPk)
    const bunkerUri = `bunker://${bunker.bunkerPk}?relay=${encodeURIComponent(
      `ws://127.0.0.1:${relayA.port}`
    )}&secret=e2e-secret`

    publishEncryptedLocator(
      relayA,
      'private',
      [{ type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' }],
      bunker.bunkerPk
    )

    const connected = await evaluate(
      chrome,
      `window.ncc.identityConnectBunker(${JSON.stringify(bunkerUri)})`
    )
    check(
      'connects a NIP-46 remote signer',
      connected?.mode === 'nip46' && connected?.npub === bunkerNpub,
      JSON.stringify(connected)
    )

    const remotePub = await evaluate(cdp, 'window.nostr.getPublicKey()')
    check('NIP-07 uses the remote signer', remotePub === bunker.bunkerPk, String(remotePub))

    const remoteEvent = await evaluate(
      cdp,
      `window.nostr.signEvent({ kind: 1, created_at: ${Math.floor(Date.now() / 1000)}, tags: [], content: 'remote e2e' })`
    )
    check(
      'remote signer signs a verifiable event',
      verifyEvent(remoteEvent) === true && remoteEvent.pubkey === bunker.bunkerPk
    )
    check('the remote signer received the request', bunker.signRequests() >= 1)

    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/private/` })
    const privateText = await waitForText(cdp, 'NCC E2E OK', 80)
    check('remote signer decrypts a targeted locator', privateText.includes('NCC E2E OK'))
    check('locator decryption went through NIP-46', bunker.decryptRequests() >= 1)

    const disconnected = await evaluate(chrome, 'window.ncc.identityDisconnect()')
    check(
      'disconnecting returns to the local identity',
      disconnected?.mode === 'local' && disconnected?.npub === signerNpub,
      JSON.stringify(disconnected)
    )
    bunker?.close()
    bunker = null

    // ncc:// links inside content must go through the shell so the service changes.
    await evaluate(cdp, 'document.querySelector("#cross").click()')
    const secureText = await waitForText(cdp, 'SECURE OK', 80)
    check('ncc:// link switches service', secureText.includes('SECURE OK'))
    await sleep(250)
    const secureSecurity = await readSecurity(chrome)
    check(
      'security lock reports pinned transport',
      secureSecurity?.label === 'pinned-tls' && secureSecurity?.tone === 'ok',
      JSON.stringify(secureSecurity)
    )
    check(
      'security lock shows an anchored dot',
      secureSecurity?.anchor === 'anchored',
      JSON.stringify(secureSecurity)
    )

    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    const trustText = await evaluate(chrome, 'document.body.innerText')
    check(
      'site info shows the matching transport keys',
      String(trustText).includes('same transport key'),
      String(trustText)
    )
    check('site info shows the anchor service id', String(trustText).includes('secure'))
    const trustShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'trust.png'), Buffer.from(trustShot.data, 'base64'))
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Site information"]\').click()')
    await sleep(250)

    // A service with only an NCC-02 record uses its `u` endpoint as the fallback.
    await evaluate(chrome, `window.ncc.newTab('ncc://${serviceNpub}/_/ncc02only/')`)
    const fallbackTarget = await waitForTarget((entry) =>
      String(entry.url).includes('/ncc02only/')
    )
    const fallbackCdp = new Cdp(fallbackTarget.webSocketDebuggerUrl)
    await fallbackCdp.connect()
    const fallbackText = await waitForText(fallbackCdp, 'NCC E2E OK', 80)
    check('serves the NCC-02 u fallback', fallbackText.includes('NCC E2E OK'))
    await sleep(300)
    const fallbackSecurity = await readSecurity(chrome)
    check(
      'security lock marks the NCC-02 fallback',
      fallbackSecurity?.anchor === 'anchored' && fallbackSecurity?.label === 'plaintext',
      JSON.stringify(fallbackSecurity)
    )
    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    check(
      'site info explains the fallback',
      (await evaluate(chrome, 'document.body.innerText')).includes(
        'served from the NCC-02 `u` endpoint'
      )
    )
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Site information"]\').click()')
    await evaluate(chrome, 'window.ncc.closeTab()')
    fallbackCdp.close()
    await sleep(400)

    // Tabs + gossip: a new tab resolves a service that only exists on the hinted relay.
    await evaluate(chrome, 'window.ncc.newTab()')
    await evaluate(chrome, `window.ncc.navigate('ncc://${serviceNpub}/_/hinted/hinted')`)
    const hintedTarget = await waitForTarget((entry) => entry.url?.includes('/hinted/hinted'))
    const hinted = new Cdp(hintedTarget.webSocketDebuggerUrl)
    await hinted.connect()
    const hintedText = await waitForText(hinted, 'HINTED OK', 80)
    check('follows NIP-65 relay hints', hintedText.includes('HINTED OK'))

    await sleep(300)
    const tabCount = await evaluate(chrome, 'document.querySelectorAll(\'[role="tab"]\').length')
    check('opens a second tab', tabCount === 2, `(got ${tabCount})`)

    // Reordering is the same path a drag-and-drop drop uses (id + destination index).
    const tabIds = await evaluate(
      chrome,
      'window.ncc.getState().then((state) => state.tabs.map((tab) => tab.id))'
    )
    check(
      'tab ids are available for reordering',
      Array.isArray(tabIds) && tabIds.length === 2,
      JSON.stringify(tabIds)
    )
    await evaluate(chrome, `window.ncc.moveTab(${JSON.stringify(tabIds[1])}, 0)`)
    await sleep(300)
    const reordered = await evaluate(
      chrome,
      'Array.from(document.querySelectorAll(\'[role="tab"]\')).map((element) => element.getAttribute("data-tab-id"))'
    )
    check(
      'reorders tabs to a drop position',
      Array.isArray(reordered) && reordered[0] === tabIds[1],
      JSON.stringify(reordered)
    )
    await evaluate(chrome, `window.ncc.moveTab(${JSON.stringify(tabIds[1])}, 2)`)
    await sleep(250)

    // The real drag path: dragstart on one tab, dragover the left half of the first,
    // then drop. State updates between events, exactly like a human drag.
    await evaluate(
      chrome,
      `(() => {
        window.__nccDrag = new DataTransfer()
        const from = document.querySelectorAll('[role="tab"]')[1]
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__nccDrag }))
        return true
      })()`
    )
    await sleep(150)
    await evaluate(
      chrome,
      `(() => {
        const to = document.querySelectorAll('[role="tab"]')[0]
        const rect = to.getBoundingClientRect()
        to.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 4,
          dataTransfer: window.__nccDrag
        }))
        return true
      })()`
    )
    await sleep(150)
    await evaluate(
      chrome,
      `(() => {
        const to = document.querySelectorAll('[role="tab"]')[0]
        const rect = to.getBoundingClientRect()
        to.dispatchEvent(new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 4,
          dataTransfer: window.__nccDrag
        }))
        return true
      })()`
    )
    await sleep(350)
    const draggedOrder = await evaluate(
      chrome,
      'Array.from(document.querySelectorAll(\'[role="tab"]\')).map((element) => element.getAttribute("data-tab-id"))'
    )
    check(
      'drag and drop reorders tabs',
      Array.isArray(draggedOrder) && draggedOrder[0] === tabIds[1],
      JSON.stringify(draggedOrder)
    )

    // The tab strip mirrors mute state, which is the same indicator shown for audio.
    await evaluate(chrome, `window.ncc.toggleMute(${JSON.stringify(tabIds[1])})`)
    await sleep(250)
    const mutedState = await evaluate(
      chrome,
      `window.ncc.getState().then((state) => state.tabs.find((tab) => tab.id === ${JSON.stringify(
        tabIds[1]
      )})?.muted)`
    )
    check(
      'mute state reaches the tab strip',
      mutedState === true &&
        (await evaluate(
          chrome,
          `Boolean(document.querySelector('[data-tab-id="${tabIds[1]}"] button[aria-label^="Unmute"]'))`
        )) === true,
      String(mutedState)
    )
    await evaluate(chrome, `window.ncc.toggleMute(${JSON.stringify(tabIds[1])})`)
    await sleep(200)

    const tabsShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'tabs.png'), Buffer.from(tabsShot.data, 'base64'))

    await evaluate(chrome, 'window.ncc.closeTab()')
    await sleep(300)
    const afterClose = await evaluate(chrome, 'document.querySelectorAll(\'[role="tab"]\').length')
    check('closes the active tab', afterClose === 1, `(got ${afterClose})`)
    hinted.close()

    // Global shortcuts must work while the page, not the chrome, has focus.
    if (spawnSync('which', ['xdotool']).status === 0) {
      const windowId = findElectronWindow(xvfb.display)
      check('finds the browser window for shortcut tests', Boolean(windowId))

      if (windowId) {
        xdotool(xvfb.display, ['windowfocus', '--sync', windowId])
        xdotool(xvfb.display, ['mousemove', '--window', windowId, '600', '500'])
        xdotool(xvfb.display, ['click', '1'])
        await sleep(300)

        xdotool(xvfb.display, ['key', '--window', windowId, '--clearmodifiers', 'ctrl+t'])
        await sleep(600)
        const afterShortcutNew = await evaluate(
          chrome,
          'document.querySelectorAll(\'[role="tab"]\').length'
        )
        check(
          'Ctrl+T opens a tab while the page is focused',
          afterShortcutNew === 2,
          `(got ${afterShortcutNew})`
        )

        // Focus the content of the new (blank) tab before using Ctrl+W.
        xdotool(xvfb.display, ['windowfocus', '--sync', windowId])
        xdotool(xvfb.display, ['mousemove', '--window', windowId, '600', '400'])
        xdotool(xvfb.display, ['click', '1'])
        await sleep(250)
        xdotool(xvfb.display, ['windowfocus', '--sync', windowId])
        xdotool(xvfb.display, ['key', '--window', windowId, '--clearmodifiers', 'ctrl+w'])
        await sleep(600)
        const afterShortcutClose = await evaluate(
          chrome,
          'document.querySelectorAll(\'[role="tab"]\').length'
        )
        check(
          'Ctrl+W closes a tab while the page is focused',
          afterShortcutClose === 1,
          `(got ${afterShortcutClose})`
        )

        // Leave the original tab active even if the shortcut test failed.
        const tabCountNow = await evaluate(
          chrome,
          'document.querySelectorAll(\'[role="tab"]\').length'
        )
        if (tabCountNow > 1) {
          await evaluate(chrome, 'window.ncc.closeTab()')
          await sleep(300)
        }

        xdotool(xvfb.display, ['windowfocus', '--sync', windowId])
        xdotool(xvfb.display, ['key', '--window', windowId, '--clearmodifiers', 'ctrl+l'])
        await sleep(300)
        const focusedLabel = await evaluate(
          chrome,
          'document.activeElement?.getAttribute("aria-label") ?? ""'
        )
        check('Ctrl+L focuses the address bar', focusedLabel === 'Address', String(focusedLabel))
      }
    } else {
      console.log('  skip  global shortcut e2e (xdotool not installed)')
    }

    // Mismatch: same k, different certificate. Must fail closed.
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/bogus/` })
    const mismatchText = await waitForText(cdp, 'Transport identity mismatch', 80)
    check(
      'refuses a certificate that does not match k',
      mismatchText.includes('Transport identity mismatch')
    )
    await sleep(250)
    const mismatchSecurity = await readSecurity(chrome)
    check(
      'security lock turns red for k-mismatch',
      mismatchSecurity?.label === 'failure' && mismatchSecurity?.tone === 'danger',
      JSON.stringify(mismatchSecurity)
    )
    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    const mismatchDetails = await evaluate(chrome, 'document.body.innerText')
    check(
      'site info reports k-mismatch',
      String(mismatchDetails).includes('k-mismatch') &&
        String(mismatchDetails).includes('Transport identity mismatch'),
      String(mismatchDetails)
    )
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Site information"]\').click()')
    await sleep(200)

    // Per-tab history: the panel lists real navigation entries and can jump between them.
    const tabHistory = await evaluate(chrome, 'window.ncc.tabHistory()')
    check(
      'exposes the active tab history',
      tabHistory?.entries?.length >= 2 && tabHistory.activeIndex === tabHistory.entries.length - 1,
      JSON.stringify(tabHistory?.entries?.length)
    )
    await evaluate(chrome, 'document.querySelector(\'button[aria-label="History (Ctrl+H)"]\').click()')
    await waitForText(chrome, 'History of this tab', 50)
    check(
      'opens the history panel',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-popover=history]"))')) === true
    )
    check(
      'history panel lists entries',
      (await evaluate(
        chrome,
        'document.querySelectorAll("[data-history-index]").length'
      )) >= 2
    )
    const historyShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'history.png'), Buffer.from(historyShot.data, 'base64'))
    await evaluate(
      chrome,
      'document.querySelector(\'[aria-label="Close History of this tab"]\').click()'
    )
    await sleep(250)

    // Bookmarks: the star, the menu list and removal.
    const bookmarked = await evaluate(chrome, 'window.ncc.toggleBookmark()')
    check(
      'bookmarks the current page',
      bookmarked?.length === 1 && String(bookmarked[0].url).includes('/bogus/'),
      JSON.stringify(bookmarked)
    )
    check(
      'address bar shows a filled bookmark star',
      (await evaluate(
        chrome,
        'Boolean(document.querySelector(\'button[aria-label="Remove bookmark"]\'))'
      )) === true
    )

    await sleep(400)
    const chromeShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'chrome.png'), Buffer.from(chromeShot.data, 'base64'))

    // Hamburger menu: the menu-bar commands live in the toolbar.
    await evaluate(chrome, 'document.querySelector(\'button[aria-label="Menu"]\').click()')
    await waitForText(chrome, 'Focus address bar', 40)
    check(
      'opens the in-app menu',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-chrome-menu]"))')) === true
    )
    check(
      'menu lists the bookmark',
      (await evaluate(
        chrome,
        'Boolean(document.querySelector("[data-bookmark-url]"))'
      )) === true
    )

    const menuShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'menu.png'), Buffer.from(menuShot.data, 'base64'))

    const tabsBeforeMenu = await evaluate(
      chrome,
      'document.querySelectorAll(\'[role="tab"]\').length'
    )
    await evaluate(chrome, 'document.querySelector(\'[data-command="new-tab"]\').click()')
    await sleep(600)
    const tabsAfterMenu = await evaluate(
      chrome,
      'document.querySelectorAll(\'[role="tab"]\').length'
    )
    check(
      'menu command opens a tab',
      tabsAfterMenu === tabsBeforeMenu + 1,
      `(${tabsBeforeMenu} → ${tabsAfterMenu})`
    )
    await evaluate(chrome, 'window.ncc.closeTab()')
    await sleep(300)

    const unbookmarked = await evaluate(
      chrome,
      `window.ncc.removeBookmark(${JSON.stringify(bookmarked[0].url)})`
    )
    check('removes a bookmark', unbookmarked?.length === 0, JSON.stringify(unbookmarked))

    // M4: the publisher app, signed by the browser's built-in NIP-07 provider, then
    // resolved back through the browser from the same relay.
    await evaluate(chrome, `window.ncc.newTab('http://127.0.0.1:${publisher.port}/')`)
    const publisherTarget = await waitForTarget((entry) =>
      String(entry.url).startsWith(`http://127.0.0.1:${publisher.port}`)
    )
    const publisherCdp = new Cdp(publisherTarget.webSocketDebuggerUrl)
    await publisherCdp.connect()
    const publisherText = await waitForText(publisherCdp, 'NCC Publisher', 80)
    check('serves the publisher app', publisherText.includes('NCC Publisher'))
    check(
      'publisher gets the built-in NIP-07 provider',
      (await evaluate(publisherCdp, 'typeof window.nostr')) === 'object'
    )

    await evaluate(
      publisherCdp,
      `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Connect signer')).click()`
    )
    await waitForText(chrome, 'Signer request', 60)
    check(
      'publisher signing reaches the approval sheet',
      (await evaluate(chrome, 'document.body.innerText')).includes(
        `127.0.0.1:${publisher.port}`
      )
    )
    await evaluate(
      chrome,
      `(() => {
        const remember = document.querySelector('[data-signer-remember]')
        if (remember && !remember.checked) remember.click()
        document.querySelector('[data-signer-allow]').click()
        return true
      })()`
    )
    const publisherNpub = await waitForValue(
      publisherCdp,
      'document.querySelector(\'p[title^="npub1"]\')?.textContent?.trim() ?? ""',
      80
    )
    check('publisher derives the signer npub', publisherNpub === signerNpub, String(publisherNpub))

    await evaluate(
      publisherCdp,
      `(() => {
        const set = (selector, value) => {
          const element = document.querySelector(selector)
          const proto = element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
          element.dispatchEvent(new Event('input', { bubbles: true }))
        }
        set('input[aria-label="Service id"]', 'pubtest')
        set('input[aria-label="Host"]', '127.0.0.1')
        set('input[aria-label="Port"]', '${servicePort}')
        set('textarea[aria-label="Relays"]', 'ws://127.0.0.1:${relayA.port}')
        return true
      })()`
    )
    await sleep(400)
    check(
      'publisher previews the clean address',
      (await evaluate(publisherCdp, 'document.body.innerText')).includes(
        `ncc://${signerNpub}/pubtest`
      )
    )

    await evaluate(
      publisherCdp,
      `Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Sign & publish')).click()`
    )
    await waitForText(publisherCdp, 'Published', 80)
    const publisherShot = await publisherCdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'publisher.png'), Buffer.from(publisherShot.data, 'base64'))

    let publishedLocator = null
    let publishedAnchor = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      publishedLocator = relayA.events.find(
        (event) =>
          event.kind === 30058 &&
          event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'pubtest')
      )
      publishedAnchor = relayA.events.find(
        (event) =>
          event.kind === 30059 &&
          event.tags.some((tag) => tag[0] === 'd' && tag[1] === 'pubtest')
      )
      if (publishedLocator && publishedAnchor) break
      await sleep(200)
    }
    check('publisher publishes the NCC-05 locator', Boolean(publishedLocator))
    check('publisher publishes the NCC-02 anchor', Boolean(publishedAnchor))
    check(
      'published locator has a valid signature',
      publishedLocator ? verifyEvent(publishedLocator) : false
    )
    const publishedPayload = publishedLocator ? JSON.parse(publishedLocator.content) : null
    check(
      'published locator points at the local port',
      String(publishedPayload?.endpoints?.[0]?.url).includes(`:${servicePort}`),
      String(publishedPayload?.endpoints?.[0]?.url)
    )

    await evaluate(chrome, `window.ncc.navigate('ncc://${signerNpub}/pubtest/')`)
    const publishedTarget = await waitForTarget((entry) =>
      String(entry.url).includes('/pubtest/')
    )
    const publishedCdp = new Cdp(publishedTarget.webSocketDebuggerUrl)
    await publishedCdp.connect()
    const publishedText = await waitForText(publishedCdp, 'NCC E2E OK', 80)
    check('browser resolves the freshly published locator', publishedText.includes('NCC E2E OK'))
    await sleep(300)
    check(
      'published service shows its NCC-02 anchor',
      (await readSecurity(chrome))?.anchor === 'anchored'
    )
    await evaluate(chrome, 'window.ncc.closeTab()')
    publishedCdp.close()
    publisherCdp.close()
    await sleep(400)

    // Anchored mode fails closed for a service with no NCC-02 record.
    const required = await evaluate(chrome, 'window.ncc.setAnchorRequired(true)')
    check(
      'enables required anchoring',
      required?.ok === true && required?.config?.anchorRequired === true,
      JSON.stringify(required)
    )
    await evaluate(chrome, `window.ncc.newTab('ncc://${serviceNpub}/_/web/')`)
    const requiredTarget = await waitForTarget((entry) => String(entry.url).includes('/_/web/'))
    const requiredCdp = new Cdp(requiredTarget.webSocketDebuggerUrl)
    await requiredCdp.connect()
    const requiredText = await waitForText(requiredCdp, 'No NCC-02 service record', 80)
    check('anchored mode refuses an unanchored service', requiredText.includes('No NCC-02 service record'))
    await sleep(300)
    const requiredSecurity = await readSecurity(chrome)
    check(
      'security lock turns red for no-anchor',
      requiredSecurity?.label === 'failure' && requiredSecurity?.tone === 'danger',
      JSON.stringify(requiredSecurity)
    )
    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    check(
      'site info reports no-anchor',
      (await evaluate(chrome, 'document.body.innerText')).includes('No NCC-02 service record')
    )
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Site information"]\').click()')
    await evaluate(chrome, 'window.ncc.closeTab()')
    requiredCdp.close()
    const disabled = await evaluate(chrome, 'window.ncc.setAnchorRequired(false)')
    check('restores optional anchoring', disabled?.config?.anchorRequired === false)
    await sleep(400)

    // Failure case: a different pubkey with no locator at all.
    await cdp.send('Page.navigate', { url: `ncc://${missingNpub}/web/` })
    const errorText = await waitForText(cdp, 'No locator published', 80)
    check('renders the no-record error page', errorText.includes('No locator published'))
    check('error page names the code', errorText.includes('no-record'))

    await sleep(400)
    const errorSecurity = await readSecurity(chrome)
    check(
      'security lock turns red for no-record',
      errorSecurity?.label === 'failure' && errorSecurity?.tone === 'danger',
      JSON.stringify(errorSecurity)
    )
    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    const errorDetails = await evaluate(chrome, 'document.body.innerText')
    check(
      'site info reports the failure code',
      String(errorDetails).includes('no-record') &&
        String(errorDetails).includes('No locator published'),
      String(errorDetails)
    )
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Site information"]\').click()')
    await sleep(200)

    const errorShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'no-record.png'), Buffer.from(errorShot.data, 'base64'))

    // The locator cache lives next to the config and holds only public records.
    const cachePath = join(userData, 'locator-cache.json')
    check('persists resolved locators to disk', existsSync(cachePath))
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      check('cache contains resolved services', Object.keys(cached.entries ?? {}).length >= 2)
      check('cache never contains encrypted records', !/\"encrypted\":\s*true/.test(readFileSync(cachePath, 'utf8')))
    }

    // Session persistence: tabs are written after a debounce, without page content.
    await sleep(1000)
    const sessionPath = join(userData, 'session.json')
    check('persists the browsing session', existsSync(sessionPath))
    if (existsSync(sessionPath)) {
      const savedSession = JSON.parse(readFileSync(sessionPath, 'utf8'))
      check(
        'session saves open tabs',
        Array.isArray(savedSession.tabs) &&
          savedSession.tabs.length >= 1 &&
          savedSession.tabs.some((tab) => String(tab.url).startsWith('ncc://')),
        JSON.stringify(savedSession.tabs)
      )
      check(
        'session stores no page content',
        !/cookie|password|content/i.test(readFileSync(sessionPath, 'utf8'))
      )
    }

    // Overflow: with more tabs than fit, the strip offers a list of every tab.
    const keepTab = await evaluate(
      chrome,
      'window.ncc.getState().then((state) => state.activeTabId)'
    )
    for (let index = 0; index < 14; index += 1) {
      await evaluate(chrome, 'window.ncc.newTab()')
    }
    await sleep(700)
    check(
      'shows the tab overflow button',
      (await evaluate(
        chrome,
        'Boolean(document.querySelector(\'button[aria-label="All tabs"]\'))'
      )) === true
    )
    await evaluate(chrome, 'document.querySelector(\'button[aria-label="All tabs"]\').click()')
    await waitForText(chrome, 'All tabs', 40)
    check(
      'overflow menu lists open tabs',
      (await evaluate(
        chrome,
        'document.querySelectorAll("[data-overflow-tab]").length'
      )) >= 14
    )
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close All tabs"]\').click()')
    await evaluate(chrome, `window.ncc.closeOtherTabs(${JSON.stringify(keepTab)})`)
    await sleep(400)
    check(
      'closes the extra tabs',
      (await evaluate(
        chrome,
        'document.querySelectorAll(\'[role="tab"]\').length'
      )) === 1
    )

    // Restart with the same profile and no command-line address: the session file
    // must bring the tab back without any extra flags.
    await sleep(1100)
    cdp.close()
    chrome.close()
    electron.kill('SIGTERM')
    await new Promise((resolve) => electron.once('exit', resolve))

    const restorePort = 9334
    restarted = spawn(
      join(ROOT, 'node_modules/.bin/electron'),
      [
        '.',
        '--no-sandbox',
        '--disable-gpu',
        '--ozone-platform=x11',
        `--remote-debugging-port=${restorePort}`,
        '--remote-allow-origins=*'
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DISPLAY: xvfb.display,
          XDG_CONFIG_HOME: configHome,
          ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
          NCC_IDENTITY_NSEC: nip19.nsecEncode(signerSk),
          NCC_NIP46_TIMEOUT_MS: '15000',
          NCC_DOWNLOAD_DIR: join(configHome, 'downloads')
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    restarted.stdout.on('data', (chunk) => {
      logs += chunk.toString()
    })
    restarted.stderr.on('data', (chunk) => {
      logs += chunk.toString()
    })

    const restoredChromeTarget = await waitForTarget(
      (entry) => entry.url?.includes('/renderer/index.html'),
      100,
      restorePort
    )
    const restoredChrome = new Cdp(restoredChromeTarget.webSocketDebuggerUrl)
    await restoredChrome.connect()
    const restoredState = await evaluate(restoredChrome, 'window.ncc.getState()')
    check(
      'restores the session on the next launch',
      restoredState?.tabs?.length === 1,
      JSON.stringify(restoredState?.tabs?.length)
    )
    check(
      'restores the saved address',
      String(restoredState?.tabs?.[0]?.url).includes(missingNpub),
      String(restoredState?.tabs?.[0]?.url)
    )

    const restoredContent = await waitForTarget(
      (entry) => String(entry.url).startsWith('ncc://'),
      100,
      restorePort
    )
    const restoredCdp = new Cdp(restoredContent.webSocketDebuggerUrl)
    await restoredCdp.connect()
    const restoredText = await waitForText(restoredCdp, 'No locator published', 80)
    check('restores the page itself', restoredText.includes('No locator published'))
    restoredCdp.close()
    restoredChrome.close()
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
