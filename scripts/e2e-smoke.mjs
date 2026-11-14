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
import { join } from 'node:path'
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
<link rel="stylesheet" href="/style.css"></head>
<body><h1 id="headline">NCC E2E OK</h1>
<p id="proxied">resolved-and-proxied</p>
<a id="next" href="second">second</a>
<a id="cross" href="ncc://${npub}/_/secure/">secure service</a></body></html>`

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
  // `hinted` only exists on relay B; relay A holds the NIP-65 list pointing there.
  publishRelayList(relayA, `ws://127.0.0.1:${relayB.port}`)
  publishLocator(relayB, 'hinted', [
    { type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' }
  ])

  console.log(`relay A ws://127.0.0.1:${relayA.port} · relay B ws://127.0.0.1:${relayB.port}`)
  console.log(`service http://127.0.0.1:${servicePort}`)
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
        NCC_NIP46_TIMEOUT_MS: '15000'
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

  const cleanup = () => {
    bunker?.close()
    electron.kill('SIGTERM')
    xvfb.proc.kill('SIGTERM')
    server.close()
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

    const chromeText = await evaluate(chrome, 'document.body.innerText')
    check('toolbar reports plaintext transport', String(chromeText).includes('plaintext'), String(chromeText))

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
    const pinnedText = await evaluate(chrome, 'document.body.innerText')
    check('toolbar reports pinned transport', String(pinnedText).includes('pinned'), String(pinnedText))

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
    const mismatchChrome = await evaluate(chrome, 'document.body.innerText')
    check('toolbar reports k-mismatch', String(mismatchChrome).includes('k-mismatch'), String(mismatchChrome))

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

    // The locator cache lives next to the config and holds only public records.
    const cachePath = join(userData, 'locator-cache.json')
    check('persists resolved locators to disk', existsSync(cachePath))
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      check('cache contains resolved services', Object.keys(cached.entries ?? {}).length >= 2)
      check('cache never contains encrypted records', !/\"encrypted\":\s*true/.test(readFileSync(cachePath, 'utf8')))
    }

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
