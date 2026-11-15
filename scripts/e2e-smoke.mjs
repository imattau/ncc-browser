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
import { connect as connectNet, createServer as createNetServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

async function startService(npub, options = {}) {
  let counter = 0
  let leakRequests = 0
  const headline = options.headline ?? 'NCC E2E OK'
  const extraBody = options.extraBody ?? ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>NCC E2E</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/style.css"></head>
<body><h1 id="headline">${headline}</h1>
<p id="proxied">resolved-and-proxied</p>
<a id="next" href="second">second</a>
<a id="download" href="/sample.txt" download="sample.txt">download</a>
<a id="login-link" href="/login">login</a>
<a id="cross" href="ncc://${npub}/_/secure/">secure service</a>${extraBody}</body></html>`

  const server = createServer((request, response) => {
    if (request.url === '/leak.png') {
      leakRequests += 1
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end()
      return
    }
    if (request.url.startsWith('/cookie-set')) {
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'ncc_cookie=normal; Path=/; SameSite=Lax'
      })
      response.end('<!doctype html><title>Cookie</title><h1 id="cookie">COOKIE SET</h1>')
      return
    }
    if (request.url.startsWith('/cookie-read')) {
      const cookie = request.headers.cookie ?? ''
      const value = cookie.match(/(?:^|;\s*)ncc_cookie=([^;]+)/)?.[1] ?? 'none'
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        `<!doctype html><title>Cookie</title><h1 id="cookie">COOKIE ${value}</h1>`
      )
      return
    }
    if (request.url === '/counter') {
      counter += 1
      response.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'public, max-age=3600'
      })
      response.end(`<!doctype html><title>Counter</title><h1 id="counter">${counter}</h1>`)
      return
    }
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
    if (request.url === '/login') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        '<!doctype html><title>Example login</title>' +
          '<h1>Sign in</h1>' +
          '<form id="login-form" action="/login" method="post" ' +
          "onsubmit=\"event.preventDefault(); document.getElementById('login-result').textContent='SUBMITTED';\">" +
          '<label>Username <input id="username" name="username" autocomplete="username"></label>' +
          '<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>' +
          '<button id="login-submit" type="submit">Sign in</button>' +
          '</form><p id="login-result"></p>'
      )
      return
    }
    if (request.url.startsWith('/search')) {
      const query = new URL(request.url, 'http://127.0.0.1').searchParams.get('q') ?? ''
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><title>Search</title><h1 id="search">SEARCH ${query}</h1>`)
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
  return {
    server,
    port: server.address().port,
    getLeakRequests: () => leakRequests
  }
}

/**
 * Tiny SOCKS5 server for the Tor e2e path. The PAC only sends *.onion hosts here,
 * and this proxy connects them to the local onion test service.
 */
async function startSocksProxy(onionPort) {
  let connections = 0
  const targets = []
  const server = createNetServer((socket) => {
    let buffer = Buffer.alloc(0)
    let stage = 'greeting'

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        const methods = buffer[1]
        if (buffer.length < 2 + methods) return
        const version = buffer[0]
        buffer = buffer.subarray(2 + methods)
        if (version !== 5) {
          socket.destroy()
          return
        }
        socket.write(Buffer.from([5, 0]))
        stage = 'request'
        onData(Buffer.alloc(0))
        return
      }

      if (stage !== 'request') return
      if (buffer.length < 5) return
      const version = buffer[0]
      const command = buffer[1]
      const addressType = buffer[3]
      let addressLength
      if (addressType === 1) addressLength = 4
      else if (addressType === 3) addressLength = buffer[4]
      else if (addressType === 4) addressLength = 16
      else {
        socket.destroy()
        return
      }

      const headerLength = addressType === 3 ? 5 : 4
      if (buffer.length < headerLength + addressLength + 2) return
      const offset = headerLength + addressLength
      if (version !== 5 || command !== 1) {
        socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
        return
      }

      let host
      let portOffset
      if (addressType === 1) {
        host = [...buffer.subarray(4, 8)].join('.')
        portOffset = 8
      } else if (addressType === 3) {
        const length = buffer[4]
        host = buffer.subarray(5, 5 + length).toString()
        portOffset = 5 + length
      } else {
        host = 'ipv6'
        portOffset = 20
      }
      const requestedPort = buffer.readUInt16BE(portOffset)
      const onion = host.endsWith('.onion')
      const targetPort = onion ? onionPort : requestedPort
      targets.push({ host, port: requestedPort, onion })
      if (!targetPort) {
        socket.destroy()
        return
      }

      stage = 'piping'
      connections += 1
      const upstream = connectNet({ host: '127.0.0.1', port: targetPort }, () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        const rest = buffer.subarray(offset + 2)
        if (rest.length) upstream.write(rest)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
    }

    socket.on('data', onData)
    socket.on('error', () => socket.destroy())
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    port: server.address().port,
    getConnections: () => connections,
    getTargets: () => targets,
    close: () => {
      if (server.listening) server.close()
    }
  }
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

function publishSignerRelayList(relay, writeRelayUrl) {
  const event = finalizeEvent(
    {
      kind: 10002,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['r', writeRelayUrl, 'write']],
      content: ''
    },
    signerSk
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
        anchor: button.getAttribute('data-anchor-state'),
        tooltip: button.getAttribute('title')
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
  const result = xdotool(display, ['search', '--onlyvisible', '--name', 'Nostr Navigator'])
  if (result.status !== 0) return null
  return result.stdout.trim().split('\n').filter(Boolean)[0] ?? null
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true })

  const relayA = await startRelay()
  const relayB = await startRelay()
  const directService = await startService(serviceNpub)
  const servicePort = directService.port
  const onionService = await startService(serviceNpub, {
    headline: 'ONION E2E OK',
    extraBody: `<img id="leak" src="http://127.0.0.1:${servicePort}/leak.png" alt="">`
  })
  const onionPort = onionService.port
  const torProxy = await startSocksProxy(onionPort)
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
    { type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' },
    { type: 'http', uri: `e2e.onion:${onionPort}`, priority: 1, family: 'onion' }
  ])
  publishLocator(relayA, 'toronly', [
    { type: 'http', uri: `e2e.onion:${onionPort}`, priority: 1, family: 'onion' }
  ])
  publishLocator(relayA, 'directonly', [
    { type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' }
  ])
  publishLocator(relayA, 'mixed', [
    { type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' },
    {
      type: 'https',
      uri: `127.0.0.1:${secure.port}`,
      priority: 10,
      family: 'ipv4',
      k: pinnedK
    }
  ])
  publishLocator(relayA, 'insecure', [
    { type: 'http', uri: 'example.invalid', priority: 1, family: 'ipv4' }
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
  publishSignerRelayList(relayA, `ws://127.0.0.1:${relayB.port}`)
  publishLocator(relayB, 'hinted', [
    { type: 'http', uri: `127.0.0.1:${servicePort}`, priority: 1, family: 'ipv4' }
  ])

  console.log(`relay A ws://127.0.0.1:${relayA.port} · relay B ws://127.0.0.1:${relayB.port}`)
  console.log(`service http://127.0.0.1:${servicePort}`)
  console.log(`onion http://e2e.onion:${onionPort} via socks5://127.0.0.1:${torProxy.port}`)
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
  const passwordImportPath = join(configHome, 'import-passwords.csv')
  const passwordExportDir = join(configHome, 'password-exports')
  writeFileSync(
    passwordImportPath,
    'name,url,username,password,notes\nImported login,https://imported.example,carol,imported-pass,from csv\n'
  )
  mkdirSync(passwordExportDir, { recursive: true })

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
        NCC_DOWNLOAD_DIR: join(configHome, 'downloads'),
        NCC_TOR_SOCKS: `socks5://127.0.0.1:${torProxy.port}`,
        NCC_PASSWORDS_IMPORT: passwordImportPath,
        NCC_PASSWORDS_EXPORT: passwordExportDir,
        NCC_EXTENSION_DIR: join(ROOT, 'test/fixtures/hello-extension')
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
    directService.server.close()
    onionService.server.close()
    torProxy.close()
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

    await waitForValue(
      cdp,
      'document.documentElement.dataset.helloExtension === "1" ? "ready" : ""',
      80
    )
    check('injects a content script into an ncc page', true)
    const extensionCount = await waitForValue(
      cdp,
      'document.documentElement.dataset.helloCount || ""',
      80
    )
    check('routes content-script messages to the background', extensionCount === '1', String(extensionCount))
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

    check(
      'shows the extension action in the toolbar',
      (await evaluate(
        chrome,
        'Boolean(document.querySelector("[data-extension-action]"))'
      )) === true
    )

    await evaluate(cdp, 'document.querySelector("#ncc-ext-sign").click()')
    await waitForValue(
      chrome,
      'document.querySelector("[data-signer-prompt]") ? "ready" : ""',
      80
    )
    check(
      'shows the extension name in the signer prompt',
      (await evaluate(chrome, 'document.body.innerText')).includes('Hello NCC')
    )
    await evaluate(chrome, 'document.querySelector("[data-signer-remember]").click()')
    await evaluate(chrome, 'document.querySelector("[data-signer-allow]").click()')
    const signedId = await waitForValue(
      cdp,
      'document.documentElement.dataset.helloSigned || ""',
      120
    )
    check('signs a Nostr event through the extension bridge', /^[0-9a-f]{64}$/.test(signedId))
    check(
      'returns the identity public key to the extension',
      (await evaluate(cdp, 'document.documentElement.dataset.helloPubkey')) === signerPk
    )

    await evaluate(
      chrome,
      'document.querySelector("[data-extension-action]").click()'
    )
    const popupTarget = await waitForTarget((entry) => entry.url?.includes('/popup.html'), 80)
    const popup = new Cdp(popupTarget.webSocketDebuggerUrl)
    await popup.connect()
    check(
      'opens the extension popup',
      (await waitForText(popup, 'Hello NCC', 40)).includes('Hello NCC')
    )
    await evaluate(popup, 'window.close()')

    await evaluate(
      chrome,
      'window.ncc.extensionsState().then((state) => window.ncc.extensionsOpenOptions(state.extensions[0].id))'
    )
    const optionsTarget = await waitForTarget((entry) => entry.url?.includes('/options.html'), 80)
    const options = new Cdp(optionsTarget.webSocketDebuggerUrl)
    await options.connect()
    const optionsText = await waitForText(options, 'Hello NCC', 40)
    check('opens the extension options page', optionsText.includes('Hello NCC'))
    check(
      'serves extension pages from the ncc-ext origin',
      String(await evaluate(options, 'location.origin')).startsWith('ncc-ext://')
    )
    await evaluate(options, 'window.close()')


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
    const bannerText = await evaluate(
      chrome,
      'document.querySelector("[data-insecure-banner]")?.textContent ?? ""'
    )
    const bannerBox = await evaluate(
      chrome,
      `(() => {
        const element = document.querySelector('[data-insecure-banner]')
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { height: Math.round(rect.height), text: element.textContent }
      })()`
    )
    check(
      'shows the HTTP warning banner',
      String(bannerText).includes('Not secure') && bannerBox?.height === 30,
      JSON.stringify(bannerBox)
    )

    // The site information panel explains what anchoring would add.
    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    check(
      'opens the site information panel',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-popover=site-info]"))')) === true
    )
    const infoPosition = await evaluate(
      chrome,
      `(() => {
        const button = document.querySelector('[data-security-button]').getBoundingClientRect()
        const panel = document.querySelector('[data-popover=site-info]').getBoundingClientRect()
        return {
          buttonBottom: Math.round(button.bottom),
          buttonLeft: Math.round(button.left),
          panelTop: Math.round(panel.top),
          panelLeft: Math.round(panel.left)
        }
      })()`
    )
    check(
      'site info opens under the padlock',
      infoPosition.panelTop >= infoPosition.buttonBottom &&
        infoPosition.panelTop - infoPosition.buttonBottom <= 20 &&
        Math.abs(infoPosition.panelLeft - infoPosition.buttonLeft) <= 20,
      JSON.stringify(infoPosition)
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

    // --- Address bar: scheme inference, suggestions and search ---------------
    const typeAddress = async (text) => {
      await evaluate(
        chrome,
        `(() => {
          const input = document.querySelector('input[aria-label="Address"]')
          input.focus()
          input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(input, ${JSON.stringify(text)})
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })()`
      )
    }
    const pressKey = async (key) => {
      await evaluate(
        chrome,
        `(() => {
          const input = document.querySelector('input[aria-label="Address"]')
          input.dispatchEvent(
            new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })
          )
        })()`
      )
    }

    // A bare npub is an NCC address, and a bare loopback host gets a scheme.
    await evaluate(chrome, `window.ncc.navigate(${JSON.stringify(`${serviceNpub}/web/`)})`)
    await waitForText(cdp, 'NCC E2E OK', 80)
    check(
      'infers ncc:// for a bare npub',
      (await evaluate(chrome, 'window.ncc.getState().then((s) => s.displayUrl)')) ===
        `ncc://${serviceNpub}/web/`,
      String(await evaluate(chrome, 'window.ncc.getState().then((s) => s.displayUrl)'))
    )

    await evaluate(
      chrome,
      `window.ncc.navigate(${JSON.stringify(`127.0.0.1:${servicePort}/second`)})`
    )
    await waitForText(cdp, 'SECOND PAGE', 80)
    check(
      'infers http:// for a bare loopback host',
      String(
        await evaluate(chrome, 'window.ncc.getState().then((s) => s.displayUrl)')
      ).startsWith(`http://127.0.0.1:${servicePort}/second`),
      String(await evaluate(chrome, 'window.ncc.getState().then((s) => s.displayUrl)'))
    )

    const searchTemplate = `http://127.0.0.1:${servicePort}/search?q=%s`
    const searchConfig = await evaluate(
      chrome,
      `window.ncc.setSearchConfig({ engine: 'custom', custom: ${JSON.stringify(searchTemplate)}, useOnionSearch: true })`
    )
    check('saves a custom search engine', searchConfig?.ok === true, JSON.stringify(searchConfig))

    await typeAddress('nostr relays')
    await sleep(300)
    const actionRow = await evaluate(
      chrome,
      'document.querySelector("[data-omnibox-suggestion=action]")?.textContent ?? ""'
    )
    check(
      'labels the search action before pressing Enter',
      String(actionRow).includes('nostr relays') && String(actionRow).includes('Search'),
      String(actionRow)
    )
    await pressKey('Enter')
    await waitForText(cdp, 'SEARCH nostr relays', 100)
    check(
      'searches with the configured engine',
      (await waitForText(cdp, 'SEARCH nostr relays', 40)).includes('SEARCH nostr relays')
    )

    // History contributes suggestions, and the arrow keys pick a row.
    await typeAddress('second')
    await sleep(300)
    const suggestionKinds = await evaluate(
      chrome,
      '[...document.querySelectorAll("[data-omnibox-suggestion]")].map((el) => el.getAttribute("data-omnibox-suggestion"))'
    )
    check(
      'offers both the search action and a history entry',
      suggestionKinds.includes('action') && suggestionKinds.includes('history'),
      JSON.stringify(suggestionKinds)
    )
    const suggestionShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'omnibox.png'),
      Buffer.from(suggestionShot.data, 'base64')
    )
    await pressKey('ArrowDown')
    await pressKey('ArrowDown')
    const activeUrl = await evaluate(
      chrome,
      'document.querySelector("[data-omnibox-active=true]")?.getAttribute("data-omnibox-url") ?? ""'
    )
    check('arrow keys select a suggestion', String(activeUrl).includes('/second'), String(activeUrl))
    await pressKey('Enter')
    await waitForText(cdp, 'SECOND PAGE', 80)
    check(
      'opens the selected suggestion',
      String(await evaluate(chrome, 'window.ncc.getState().then((s) => s.displayUrl)')).includes(
        '/second'
      )
    )

    // Tab completes the highlighted row without navigating.
    await typeAddress('127.0.0.1')
    await sleep(300)
    await pressKey('ArrowDown')
    await pressKey('Tab')
    const completed = await evaluate(
      chrome,
      'document.querySelector(\'input[aria-label="Address"]\').value'
    )
    check(
      'Tab completes the selected suggestion',
      String(completed).startsWith('http://127.0.0.1'),
      String(completed)
    )
    await evaluate(chrome, 'document.querySelector(\'input[aria-label="Address"]\').blur()')
    await sleep(200)

    // A pasted private key is refused locally and never searched.
    await evaluate(chrome, `window.ncc.navigate(${JSON.stringify(`nsec1${'q'.repeat(58)}`)})`)
    await sleep(300)
    const secretFailure = await evaluate(chrome, 'window.ncc.getState().then((s) => s.failure)')
    check(
      'refuses a private key typed in the address bar',
      secretFailure?.code === 'secret-key',
      JSON.stringify(secretFailure)
    )

    // The history file is local, includes ncc:// pages and is written atomically.
    const recorded = JSON.parse(readFileSync(join(userData, 'history.json'), 'utf8'))
    check(
      'writes normal-tab history',
      Array.isArray(recorded.entries) &&
        recorded.entries.some((entry) => String(entry.url).includes('/second')) &&
        recorded.entries.some((entry) =>
          String(entry.url).startsWith(`ncc://${serviceNpub}/`)
        ),
      JSON.stringify(recorded.entries.slice(0, 5).map((entry) => entry.url))
    )

    await evaluate(chrome, `window.ncc.navigate(${JSON.stringify(`ncc://${serviceNpub}/web/`)})`)
    await waitForText(cdp, 'NCC E2E OK', 80)

    // Private tabs use their own in-memory session. Cookies survive between
    // private tabs but are cleared when the last one closes.
    const normalTabId = await evaluate(
      chrome,
      'window.ncc.getState().then((state) => state.activeTabId)'
    )
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/web/cookie-set` })
    await waitForText(cdp, 'COOKIE SET', 80)
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/web/cookie-read?normal=1` })
    const normalCookie = await waitForText(cdp, 'COOKIE normal', 80)
    check('normal tab stores its cookie', normalCookie.includes('COOKIE normal'))

    const privateOneId = await evaluate(
      chrome,
      `window.ncc.newPrivateTab('ncc://${serviceNpub}/_/web/cookie-read?private=1')`
    )
    const privateOneTarget = await waitForTarget((entry) =>
      String(entry.url).includes('/_/web/cookie-read?private=1')
    )
    const privateOne = new Cdp(privateOneTarget.webSocketDebuggerUrl)
    await privateOne.connect()
    const privateOneText = await waitForText(privateOne, 'COOKIE none', 80)
    check('private tab starts without normal cookies', privateOneText.includes('COOKIE none'))
    await waitForValue(
      privateOne,
      'document.documentElement.dataset.helloExtension === "1" ? "ready" : ""',
      80
    )
    check('runs extensions in private tabs when allowed', true)
    check(
      'private tab is marked in the chrome',
      (await evaluate(
        chrome,
        'window.ncc.getState().then((state) => state.tabKind)'
      )) === 'private' &&
        (await evaluate(
          chrome,
          'Boolean(document.querySelector(\'[data-tab-kind="private"]\'))'
        )) === true &&
        (await evaluate(
          chrome,
          'Boolean(document.querySelector(\'[data-tab-kind-badge="private"]\'))'
        )) === true
    )

    await privateOne.send('Page.navigate', {
      url: `ncc://${serviceNpub}/_/web/cookie-set?private=1`
    })
    await waitForText(privateOne, 'COOKIE SET', 80)
    await privateOne.send('Page.navigate', {
      url: `ncc://${serviceNpub}/_/web/cookie-read?private=1b`
    })
    const privateCookie = await waitForText(privateOne, 'COOKIE normal', 80)
    check('private tab keeps its own cookie', privateCookie.includes('COOKIE normal'))

    const privateTwoId = await evaluate(
      chrome,
      `window.ncc.newPrivateTab('ncc://${serviceNpub}/_/web/cookie-read?private=2')`
    )
    const privateTwoTarget = await waitForTarget((entry) =>
      String(entry.url).includes('/_/web/cookie-read?private=2')
    )
    const privateTwo = new Cdp(privateTwoTarget.webSocketDebuggerUrl)
    await privateTwo.connect()
    const privateTwoText = await waitForText(privateTwo, 'COOKIE normal', 80)
    check(
      'private tabs share one in-memory session',
      privateTwoText.includes('COOKIE normal')
    )

    await evaluate(chrome, `window.ncc.closeTab(${JSON.stringify(privateTwoId)})`)
    await evaluate(chrome, `window.ncc.closeTab(${JSON.stringify(privateOneId)})`)
    privateOne.close()
    privateTwo.close()
    await sleep(250)

    const privateThreeId = await evaluate(
      chrome,
      `window.ncc.newPrivateTab('ncc://${serviceNpub}/_/web/cookie-read?private=3')`
    )
    const privateThreeTarget = await waitForTarget((entry) =>
      String(entry.url).includes('/_/web/cookie-read?private=3')
    )
    const privateThree = new Cdp(privateThreeTarget.webSocketDebuggerUrl)
    await privateThree.connect()
    const privateThreeText = await waitForText(privateThree, 'COOKIE none', 80)
    check(
      'clears private cookies after the last private tab closes',
      privateThreeText.includes('COOKIE none')
    )
    await evaluate(chrome, `window.ncc.closeTab(${JSON.stringify(privateThreeId)})`)
    privateThree.close()

    await evaluate(chrome, `window.ncc.selectTab(${JSON.stringify(normalTabId)})`)
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/web/cookie-read?normal=2` })
    const normalCookieAgain = await waitForText(cdp, 'COOKIE normal', 80)
    check(
      'normal session keeps its cookies across private tabs',
      normalCookieAgain.includes('COOKIE normal')
    )
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/web/` })
    await waitForText(cdp, 'NCC E2E OK', 80)

    // Private tabs never touch the suggestion history file.
    const historyAfterPrivate = JSON.parse(readFileSync(join(userData, 'history.json'), 'utf8'))
    check(
      'never records private tabs in history',
      !JSON.stringify(historyAfterPrivate.entries).includes('private=') &&
        historyAfterPrivate.entries.some((entry) => String(entry.url).includes('cookie-read')),
      JSON.stringify(historyAfterPrivate.entries.slice(0, 6).map((entry) => entry.url))
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
      (await evaluate(chrome, 'Boolean(document.querySelector("#new-relay"))')) === true
    )
    check(
      'settings page exposes NCC-02 anchoring',
      (await evaluate(chrome, 'Boolean(document.querySelector("#anchor-required"))')) === true
    )
    check(
      'settings page exposes the search engine',
      (await evaluate(chrome, 'Boolean(document.querySelector("#search-engine"))')) === true &&
        (await evaluate(
          chrome,
          'document.querySelector("#search-engine").value'
        )) === 'custom'
    )
    const generalShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'settings-general.png'), Buffer.from(generalShot.data, 'base64'))
    await evaluate(chrome, 'document.querySelector(\'[data-settings-section="security"]\').click()')
    await waitForText(chrome, 'Secure connections', 40)
    check(
      'settings page exposes the HTTPS policy',
      (await evaluate(chrome, 'Boolean(document.querySelector("#https-mode"))')) === true
    )
    check(
      'settings page exposes the HTTP interstitial toggle',
      (await evaluate(chrome, 'Boolean(document.querySelector("#warn-insecure"))')) === true
    )
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

    const publisherSecurity = await readSecurity(chrome)
    check(
      'clearnet HTTP shows an insecure lock',
      publisherSecurity?.label === 'insecure' && publisherSecurity?.tone === 'warn',
      JSON.stringify(publisherSecurity)
    )
    const clearnetShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'clearnet.png'), Buffer.from(clearnetShot.data, 'base64'))
    await evaluate(chrome, 'document.querySelector("[data-security-button]").click()')
    await waitForText(chrome, 'Site information', 40)
    check(
      'clearnet site info explains HTTP',
      (await evaluate(chrome, 'document.body.innerText')).includes('Not secure (HTTP)')
    )
    await evaluate(chrome, 'document.querySelector(\'[aria-label="Close Site information"]\').click()')
    await sleep(250)

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

    // The toolbar refresh must bypass the HTTP cache. The test service sets
    // max-age=3600 and increments a counter per actual document request.
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/web/counter` })
    const counterOne = await waitForText(cdp, '1', 80)
    check('loads the cache-counter page', counterOne.includes('1'))
    await evaluate(
      chrome,
      'document.querySelector(\'button[aria-label^="Refresh page"]\').click()'
    )
    const counterTwo = await waitForText(cdp, '2', 80)
    check('refresh button bypasses the cache', counterTwo.includes('2'))

    // Tor transport: the locator publishes both a direct and an onion endpoint.
    // The onion endpoint is reached through a local SOCKS5 server standing in for
    // Tor, and the onion service page embeds a clearnet image that strict mode
    // must block.
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/web/` })
    await waitForText(cdp, 'NCC E2E OK', 80)
    await sleep(400)
    const torInitial = await evaluate(chrome, 'window.ncc.getState().then((s) => s.tor)')
    check(
      'reports an available onion endpoint',
      torInitial?.onionAvailable === true && torInitial?.active === false,
      JSON.stringify(torInitial)
    )
    check(
      'shows the onion toggle',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-tor-button]"))')) === true
    )
    const connectionsBefore = torProxy.getConnections()
    await evaluate(chrome, 'document.querySelector("[data-tor-button]").click()')
    await waitForText(cdp, 'ONION E2E OK', 120)
    await sleep(400)
    const torActive = await evaluate(chrome, 'window.ncc.getState().then((s) => s.tor)')
    check(
      'switches to the onion endpoint over Tor',
      torActive?.onionAvailable === true && torActive?.active === true,
      JSON.stringify(torActive)
    )
    check('uses the SOCKS proxy', torProxy.getConnections() > connectionsBefore)
    check(
      'marks the onion toggle active',
      (await evaluate(
        chrome,
        'document.querySelector("[data-tor-button]").getAttribute("data-tor-active")'
      )) === 'true'
    )
    check('blocks clearnet subresources on a Tor page', directService.getLeakRequests() === 0)
    const torSecurity = await readSecurity(chrome)
    check(
      'padlock reports the onion transport',
      torSecurity?.label === 'onion' && torSecurity?.tone === 'warn',
      JSON.stringify(torSecurity)
    )
    const onionShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'onion.png'), Buffer.from(onionShot.data, 'base64'))

    await evaluate(chrome, 'document.querySelector("[data-tor-button]").click()')
    await waitForText(cdp, 'NCC E2E OK', 120)
    await sleep(400)
    const torDirect = await evaluate(chrome, 'window.ncc.getState().then((s) => s.tor)')
    check(
      'deselecting returns to the direct endpoint',
      torDirect?.active === false,
      JSON.stringify(torDirect)
    )
    check(
      'marks the onion toggle inactive',
      (await evaluate(
        chrome,
        'document.querySelector("[data-tor-button]").getAttribute("data-tor-active")'
      )) === 'false'
    )

    // Prefer Tor automatically selects the onion endpoint and hides the toggle.
    const preferOn = await evaluate(
      chrome,
      `window.ncc.setTorConfig({ preferTor: true, mode: 'local', socks: 'socks5://127.0.0.1:${torProxy.port}' })`
    )
    check(
      'enables Prefer Tor connections',
      preferOn?.ok === true && preferOn?.config?.preferTor === true,
      JSON.stringify(preferOn)
    )
    await waitForText(cdp, 'ONION E2E OK', 120)
    await sleep(500)
    const automatic = await evaluate(chrome, 'window.ncc.getState().then((s) => s.tor)')
    check(
      'prefers onion automatically',
      automatic?.preferTor === true && automatic?.active === true,
      JSON.stringify(automatic)
    )
    check(
      'hides the onion toggle when Tor is preferred',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-tor-button]"))')) === false
    )

    const preferOff = await evaluate(
      chrome,
      `window.ncc.setTorConfig({ preferTor: false, mode: 'local', socks: 'socks5://127.0.0.1:${torProxy.port}' })`
    )
    check('disables Prefer Tor connections', preferOff?.config?.preferTor === false)
    await waitForText(cdp, 'NCC E2E OK', 120)
    await sleep(400)
    check(
      'restores the onion toggle after disabling the preference',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-tor-button]"))')) === true
    )

    // Typing a .onion URL directly goes through the same Tor path.
    await cdp.send('Page.navigate', { url: `http://e2e.onion:${onionPort}/` })
    await waitForText(cdp, 'ONION E2E OK', 120)
    await sleep(400)
    const directOnion = await evaluate(
      chrome,
      'window.ncc.getState().then((s) => ({ mode: s.mode, tor: s.tor, url: s.displayUrl }))'
    )
    check(
      'loads a direct onion URL over Tor',
      directOnion?.mode === 'web' &&
        directOnion?.tor?.active === true &&
        String(directOnion?.url).includes('e2e.onion'),
      JSON.stringify(directOnion)
    )

    // An onion-only locator explains the failure and offers the toggle.
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/toronly/` })
    const onionOnlyText = await waitForText(cdp, 'Onion endpoint only', 80)
    check('explains an onion-only service', onionOnlyText.includes('onion-only'))
    const onionOnlyState = await evaluate(chrome, 'window.ncc.getState().then((s) => s.tor)')
    check(
      'offers the onion toggle on an onion-only error',
      onionOnlyState?.onionAvailable === true &&
        (await evaluate(
          chrome,
          'Boolean(document.querySelector("[data-tor-button]"))'
        )) === true,
      JSON.stringify(onionOnlyState)
    )

    await evaluate(chrome, 'window.ncc.runCommand("open-settings")')
    await waitForText(chrome, 'Prefer Tor connections', 40)
    check(
      'settings page exposes the Tor toggle',
      (await evaluate(chrome, 'Boolean(document.querySelector("#prefer-tor"))')) === true
    )
    check(
      'settings page exposes the Tor proxy mode',
      (await evaluate(chrome, 'Boolean(document.querySelector("#tor-mode"))')) === true
    )
    const settingsTorShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(ARTIFACTS, 'settings-tor.png'), Buffer.from(settingsTorShot.data, 'base64'))
    await evaluate(
      chrome,
      'window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))'
    )
    await sleep(400)

    // A full Tor tab routes page traffic, ncc endpoint fetches and NCC relay
    // queries through the fixed SOCKS proxy.
    const torTabId = await evaluate(
      chrome,
      `window.ncc.newTorTab('ncc://${serviceNpub}/_/directonly/')`
    )
    const torTabTarget = await waitForTarget((entry) =>
      String(entry.url).includes('/_/directonly/')
    )
    const torTabCdp = new Cdp(torTabTarget.webSocketDebuggerUrl)
    await torTabCdp.connect()
    await waitForText(torTabCdp, 'NCC E2E OK', 120)
    check(
      'does not run extensions in Tor tabs',
      (await evaluate(
        torTabCdp,
        'document.documentElement.dataset.helloExtension ?? ""'
      )) === ''
    )
    await sleep(500)
    const torTabState = await evaluate(
      chrome,
      'window.ncc.getState().then((s) => ({ tabKind: s.tabKind, tor: s.tor }))'
    )
    check(
      'opens a full Tor tab',
      torTabState?.tabKind === 'tor' &&
        torTabState?.tor?.tabTor === true &&
        torTabState?.tor?.active === true,
      JSON.stringify(torTabState)
    )
    check(
      'marks the Tor tab in the chrome',
      (await evaluate(
        chrome,
        'Boolean(document.querySelector(\'[data-tab-kind="tor"]\'))'
      )) === true &&
        (await evaluate(
          chrome,
          'Boolean(document.querySelector(\'[data-tab-kind-badge="tor"]\'))'
        )) === true &&
        (await evaluate(
          chrome,
          'Boolean(document.querySelector("[data-tor-button]"))'
        )) === false
    )
    const torTargets = torProxy.getTargets()
    check(
      'routes the Tor tab endpoint through the SOCKS proxy',
      torTargets.some((target) => target.port === servicePort),
      JSON.stringify(torTargets.slice(-8))
    )
    check(
      'routes NCC relay lookups through the SOCKS proxy',
      torTargets.some((target) => target.port === relayA.port),
      JSON.stringify(torTargets.slice(-8))
    )
    const torTabSecurity = await readSecurity(chrome)
    check(
      'Tor tab security says HTTP over Tor',
      torTabSecurity?.label === 'plaintext' &&
        torTabSecurity?.tone === 'warn' &&
        String(torTabSecurity?.tooltip ?? '').includes('over Tor'),
      JSON.stringify(torTabSecurity)
    )
    check(
      'Tor tab shows the HTTP-over-Tor banner',
      String(
        await evaluate(
          chrome,
          'document.querySelector("[data-insecure-banner]")?.textContent ?? ""'
        )
      ).includes('HTTP over Tor')
    )

    await evaluate(chrome, `window.ncc.closeTab(${JSON.stringify(torTabId)})`)
    torTabCdp.close()
    await sleep(400)

    // HTTPS preference uses the HTTPS endpoint the publisher actually published,
    // even when an HTTP endpoint has a better priority.
    await evaluate(chrome, `window.ncc.selectTab(${JSON.stringify(normalTabId)})`)
    await evaluate(
      chrome,
      "window.ncc.setSecurityConfig({ httpsMode: 'prefer', warnInsecure: false })"
    )
    await sleep(600)
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/mixed/` })
    const mixedHttps = await waitForText(cdp, 'SECURE OK', 100)
    check('prefers a published HTTPS endpoint', mixedHttps.includes('SECURE OK'))
    await sleep(400)
    const mixedSecurity = await readSecurity(chrome)
    check(
      'HTTPS endpoint keeps its pinned transport',
      mixedSecurity?.label === 'pinned-tls' && mixedSecurity?.tone === 'ok',
      JSON.stringify(mixedSecurity)
    )

    await evaluate(
      chrome,
      "window.ncc.setSecurityConfig({ httpsMode: 'off', warnInsecure: false })"
    )
    await sleep(600)
    const mixedHttp = await waitForText(cdp, 'NCC E2E OK', 100)
    check('HTTPS off follows the published priority', mixedHttp.includes('NCC E2E OK'))

    await evaluate(
      chrome,
      "window.ncc.setSecurityConfig({ httpsMode: 'only', warnInsecure: false })"
    )
    await sleep(600)
    const mixedOnly = await waitForText(cdp, 'SECURE OK', 100)
    check('HTTPS only uses the secure endpoint', mixedOnly.includes('SECURE OK'))

    // An HTTP-only NCC service gets a blocking warning in HTTPS-only mode.
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/insecure/` })
    const insecureWarning = await waitForText(cdp, 'This service does not offer HTTPS', 100)
    check(
      'warns before an HTTP-only NCC service',
      insecureWarning.includes('Continue over HTTP') &&
        insecureWarning.includes('HTTPS required')
    )
    await evaluate(cdp, 'document.querySelector("a.button").click()')
    await sleep(700)
    const nccExceptionConfig = await evaluate(chrome, 'window.ncc.getConfig()')
    check(
      'records the NCC HTTP exception only after confirmation',
      Array.isArray(nccExceptionConfig?.httpExceptions) &&
        nccExceptionConfig.httpExceptions.includes(`ncc://${serviceNpub}/insecure`) &&
        (await waitForText(cdp, 'Endpoint unreachable', 80)).includes('Endpoint unreachable')
    )
    await evaluate(chrome, 'window.ncc.clearHttpExceptions()')

    // A non-loopback clearnet HTTP URL gets the chrome interstitial.
    await evaluate(
      chrome,
      "window.ncc.setSecurityConfig({ httpsMode: 'off', warnInsecure: true })"
    )
    await evaluate(chrome, "window.ncc.navigate('http://example.invalid/')")
    await waitForText(chrome, 'This connection is not secure', 80)
    check(
      'shows the clearnet HTTP interstitial',
      (await evaluate(
        chrome,
        'document.querySelector("[data-insecure-prompt]")?.textContent ?? ""'
      )).includes('example.invalid')
    )
    await evaluate(chrome, 'document.querySelector("[data-insecure-always]").click()')
    await sleep(500)
    const exceptionConfig = await evaluate(chrome, 'window.ncc.getConfig()')
    check(
      'persists an HTTP exception from the interstitial',
      Array.isArray(exceptionConfig?.httpExceptions) &&
        exceptionConfig.httpExceptions.includes('http://example.invalid')
    )
    await evaluate(chrome, 'window.ncc.clearHttpExceptions()')
    await evaluate(
      chrome,
      "window.ncc.setSecurityConfig({ httpsMode: 'only', warnInsecure: false })"
    )
    await evaluate(chrome, "window.ncc.navigate('http://example.invalid/')")
    await waitForText(chrome, 'HTTPS is unavailable', 80)
    check(
      'HTTPS-only explains the clearnet fallback',
      (await evaluate(
        chrome,
        'document.querySelector("[data-insecure-prompt]")?.textContent ?? ""'
      )).includes('Continue once')
    )
    await evaluate(chrome, 'document.querySelector("[data-insecure-go-back]").click()')
    await sleep(300)

    await evaluate(
      chrome,
      "window.ncc.setSecurityConfig({ httpsMode: 'prefer', warnInsecure: false })"
    )
    await cdp.send('Page.navigate', { url: `ncc://${serviceNpub}/_/toronly/` })
    await waitForText(cdp, 'Onion endpoint only', 80)

    // With the proxy gone, Tor must fail closed rather than fall back to direct.
    torProxy.close()
    const torDown = await evaluate(chrome, 'window.ncc.torRestart()')
    check(
      'reports Tor as unavailable',
      torDown?.ready === false && Boolean(torDown?.error),
      JSON.stringify(torDown)
    )
    await evaluate(chrome, 'document.querySelector("[data-tor-button]").click()')
    const torFailure = await waitForText(cdp, 'Tor is not available', 120)
    check('fails closed when Tor is unavailable', torFailure.includes('tor-unavailable'))

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

    // Private tabs must never be written to the restore session.
    const keepNormalId = await evaluate(
      chrome,
      'window.ncc.getState().then((state) => state.activeTabId)'
    )
    await evaluate(
      chrome,
      `window.ncc.newPrivateTab('ncc://${serviceNpub}/_/web/private-restore')`
    )
    await evaluate(chrome, `window.ncc.selectTab(${JSON.stringify(keepNormalId)})`)
    await sleep(1200)
    const savedForRestart = JSON.parse(readFileSync(join(userData, 'session.json'), 'utf8'))
    check(
      'does not save private tabs in the session',
      !JSON.stringify(savedForRestart.tabs).includes('private-restore'),
      JSON.stringify(savedForRestart.tabs)
    )

    // The privacy control removes the history file's contents.
    await evaluate(chrome, 'window.ncc.clearBrowsingHistory()')
    await sleep(200)
    const clearedHistory = JSON.parse(readFileSync(join(userData, 'history.json'), 'utf8'))
    check(
      'clears browsing history from settings',
      Array.isArray(clearedHistory.entries) && clearedHistory.entries.length === 0,
      JSON.stringify(clearedHistory.entries.length)
    )

    // Appearance: theme, text size, density, accent and motion apply immediately.
    await evaluate(chrome, 'window.ncc.runCommand("open-settings")')
    await waitForValue(
      chrome,
      'document.querySelector(\'[data-settings-section="appearance"]\') ? "ready" : ""',
      60
    )
    await evaluate(chrome, 'document.querySelector(\'[data-settings-section="appearance"]\').click()')
    await waitForText(chrome, 'Text size', 40)
    check(
      'settings exposes an appearance section',
      (await evaluate(chrome, 'Boolean(document.querySelector("[data-theme-option=dark]"))')) === true
    )
    check(
      'appearance defaults to dark',
      (await evaluate(chrome, 'document.documentElement.dataset.theme')) === 'dark' &&
        (await evaluate(chrome, 'matchMedia("(prefers-color-scheme: dark)").matches')) === true
    )
    await chrome.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 1500,
      deviceScaleFactor: 1,
      mobile: false
    })
    await sleep(250)
    const darkAppearanceShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'settings-appearance-dark.png'),
      Buffer.from(darkAppearanceShot.data, 'base64')
    )

    await evaluate(chrome, 'document.querySelector(\'[data-theme-option="light"]\').click()')
    await sleep(250)
    check(
      'switches the chrome to light',
      (await evaluate(chrome, 'document.documentElement.dataset.theme')) === 'light' &&
        (await evaluate(chrome, 'getComputedStyle(document.body).backgroundColor')) ===
          'rgb(242, 244, 248)'
    )
    const lightShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'settings-appearance-light.png'),
      Buffer.from(lightShot.data, 'base64')
    )


    const sampleBefore = await evaluate(
      chrome,
      'getComputedStyle(document.querySelector("[data-text-size-sample]")).fontSize'
    )
    await evaluate(chrome, 'document.querySelector(\'[data-text-size-option="xlarge"]\').click()')
    await sleep(250)
    const sampleAfter = await evaluate(
      chrome,
      'getComputedStyle(document.querySelector("[data-text-size-sample]")).fontSize'
    )
    const samplePadding = await evaluate(
      chrome,
      'getComputedStyle(document.querySelector("[data-text-size-sample]")).paddingTop'
    )
    check(
      'text size scales only the glyphs',
      Number.parseFloat(sampleBefore) === 12 &&
        Math.abs(Number.parseFloat(sampleAfter) - 14.4) < 0.1,
      `${sampleBefore} → ${sampleAfter}`
    )
    check('text size leaves spacing fixed', Number.parseFloat(samplePadding) === 8, samplePadding)

    await evaluate(chrome, 'document.querySelector(\'[data-density-option="compact"]\').click()')
    await sleep(200)
    const spacing = await evaluate(
      chrome,
      'getComputedStyle(document.documentElement).getPropertyValue("--spacing").trim()'
    )
    check(
      'compact density tightens the spacing scale',
      Number.parseFloat(spacing) < 0.25,
      spacing
    )

    await evaluate(chrome, 'document.querySelector(\'[data-accent-option="green"]\').click()')
    await evaluate(chrome, 'document.querySelector("[data-reduce-motion-toggle]").click()')
    await sleep(250)
    check(
      'accent changes apply immediately',
      (await evaluate(chrome, 'document.documentElement.dataset.accent')) === 'green'
    )
    check(
      'reduce motion applies immediately',
      (await evaluate(chrome, 'document.documentElement.dataset.reduceMotion')) === 'true' &&
        (await evaluate(
          chrome,
          'parseFloat(getComputedStyle(document.querySelector(\'[data-theme-option="dark"]\')).transitionDuration)'
        )) < 0.01
    )
    check(
      'appearance is persisted to config',
      String(
        await evaluate(
          chrome,
          'window.ncc.getConfig().then((config) => JSON.stringify(config.appearance))'
        )
      ).includes('"textSize":"xlarge"')
    )
    const appearanceShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'settings-appearance.png'),
      Buffer.from(appearanceShot.data, 'base64')
    )

    await evaluate(
      chrome,
      'document.querySelector(\'[data-settings-section="extensions"]\').click()'
    )
    await waitForText(chrome, 'Hello NCC', 60)
    const extensionsShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'settings-extensions.png'),
      Buffer.from(extensionsShot.data, 'base64')
    )
    await chrome.send('Emulation.clearDeviceMetricsOverride')

    // Password manager: encrypted vault, toolbar fill and save-on-submit.
    await evaluate(chrome, 'document.querySelector("[data-settings-page] header button").click()')
    await sleep(250)
    await evaluate(chrome, 'window.ncc.setAppearance({ theme: "dark" })')
    await sleep(250)
    await evaluate(
      chrome,
      `window.ncc.navigate(${JSON.stringify(`ncc://${serviceNpub}/web/login`)})`
    )
    await waitForText(cdp, 'Sign in', 100)

    const vaultOrigin = `ncc://${serviceNpub}/web`
    await evaluate(chrome, 'window.ncc.runCommand("open-passwords")')
    await waitForValue(
      chrome,
      'document.querySelector("[data-password-unlock]") ? "ready" : ""',
      80
    )
    await evaluate(chrome, 'document.querySelector("[data-password-unlock]").click()')
    await waitForText(chrome, 'Vault unlocked', 120)
    check('unlocks the password vault', true)
    await evaluate(chrome, 'document.querySelector("[data-settings-page] header button").click()')
    await sleep(250)

    const savedLogin = await evaluate(
      chrome,
      `window.ncc.passwordsSave(${JSON.stringify({
        origin: vaultOrigin,
        title: 'E2E login',
        username: 'alice',
        password: 's3cret',
        notes: 'e2e note',
        totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
      })})`
    )
    check('saves an encrypted login', savedLogin?.ok === true, JSON.stringify(savedLogin))
    const savedList = await evaluate(chrome, 'window.ncc.passwordsList()')
    const passwordId = savedList?.[0]?.id
    check(
      'lists the saved login without passwords',
      savedList?.length === 1 && savedList[0].hasTotp === true && !('password' in savedList[0]),
      JSON.stringify(savedList)
    )

    await evaluate(chrome, 'window.ncc.runCommand("open-passwords")')
    await waitForValue(
      chrome,
      'document.querySelector("[data-password-entry]") ? "ready" : ""',
      80
    )
    check(
      'settings lists the saved login',
      (await evaluate(chrome, 'document.body.innerText')).includes('E2E login')
    )
    const passwordShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'settings-passwords.png'),
      Buffer.from(passwordShot.data, 'base64')
    )
    await evaluate(chrome, 'document.querySelector("[data-settings-page] header button").click()')
    await sleep(250)

    await evaluate(chrome, 'document.querySelector("[data-passwords-button]").click()')
    await waitForValue(
      chrome,
      'document.querySelector("[data-password-matches]") ? "ready" : ""',
      60
    )
    check(
      'toolbar lists the matching login',
      (await evaluate(chrome, 'document.body.innerText')).includes('alice')
    )
    const popoverShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'passwords-popover.png'),
      Buffer.from(popoverShot.data, 'base64')
    )
    await evaluate(
      chrome,
      `document.querySelector('[data-password-fill="${passwordId}"]').click()`
    )
    await waitForValue(
      cdp,
      'document.querySelector("#username")?.value === "alice" ? "filled" : ""',
      80
    )
    check(
      'fills the username and password',
      (await evaluate(cdp, 'document.querySelector("#password")?.value')) === 's3cret'
    )

    // Change the password and submit with a real click so the content preload sees
    // a trusted submit event.
    await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('#password')
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, 'n3wpass')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`
    )
    const submitRect = await evaluate(
      cdp,
      `(() => {
        const rect = document.querySelector('#login-submit').getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })()`
    )
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: submitRect.x,
      y: submitRect.y,
      button: 'left',
      clickCount: 1
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: submitRect.x,
      y: submitRect.y,
      button: 'left',
      clickCount: 1
    })
    await waitForValue(
      chrome,
      'document.querySelector("[data-password-save-prompt]") ? "ready" : ""',
      80
    )
    check(
      'offers to update a changed password',
      (await evaluate(chrome, 'document.body.innerText')).includes('Update saved password')
    )
    const savePromptShot = await chrome.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(
      join(ARTIFACTS, 'password-save-prompt.png'),
      Buffer.from(savePromptShot.data, 'base64')
    )
    await evaluate(
      chrome,
      'document.querySelector(\'[data-password-save-action="save"]\').click()'
    )
    await waitForValue(
      chrome,
      'document.querySelector("[data-password-save-prompt]") ? "" : "closed"',
      80
    )
    const updatedPassword = await evaluate(
      chrome,
      `window.ncc.passwordsReveal(${JSON.stringify(passwordId)})`
    )
    check('updates the saved password', updatedPassword === 'n3wpass', String(updatedPassword))

    const totp = await evaluate(
      chrome,
      `window.ncc.passwordsTotp(${JSON.stringify(passwordId)})`
    )
    check(
      'generates a TOTP code',
      typeof totp?.code === 'string' && /^\d{6}$/.test(totp.code) && totp.period === 30,
      JSON.stringify(totp)
    )

    await evaluate(chrome, 'window.ncc.passwordsLock()')
    const lockedFill = await evaluate(
      chrome,
      `window.ncc.passwordsFill(${JSON.stringify(passwordId)})`
    )
    check('refuses to fill while locked', lockedFill?.ok === false, JSON.stringify(lockedFill))

    await evaluate(chrome, 'window.ncc.passwordsUnlock()')
    const importPreview = await evaluate(chrome, 'window.ncc.passwordsImportOpen()')
    check(
      'previews a CSV import',
      importPreview?.count === 1 && importPreview?.duplicates === 0,
      JSON.stringify(importPreview)
    )
    const importResult = await evaluate(
      chrome,
      `window.ncc.passwordsImportCommit(${JSON.stringify(importPreview.id)}, 'merge')`
    )
    check('imports CSV logins', importResult?.ok === true, JSON.stringify(importResult))
    const afterImport = await evaluate(chrome, 'window.ncc.passwordsList()')
    check(
      'imported login is in the vault',
      afterImport.some((entry) => entry.origin === 'https://imported.example'),
      JSON.stringify(afterImport.map((entry) => entry.origin))
    )

    const encryptedExport = await evaluate(chrome, 'window.ncc.passwordsExport("encrypted")')
    check(
      'exports an encrypted vault',
      encryptedExport?.ok === true && existsSync(encryptedExport.path),
      JSON.stringify(encryptedExport)
    )
    const csvExport = await evaluate(chrome, 'window.ncc.passwordsExport("csv")')
    check(
      'exports CSV with a warning path',
      csvExport?.ok === true &&
        existsSync(csvExport.path) &&
        readFileSync(csvExport.path, 'utf8').includes('imported-pass'),
      JSON.stringify(csvExport)
    )

    const vaultEvents = relayA.events.filter(
      (entry) =>
        entry.kind === 30078 &&
        entry.tags.some((tag) => tag[0] === 'd' && tag[1] === 'ncc-browser/passwords/v1')
    )
    check('publishes the vault to a relay', vaultEvents.length > 0)
    check(
      'follows NIP-65 write relays for the vault',
      relayB.events.some(
        (entry) =>
          entry.kind === 30078 &&
          entry.tags.some((tag) => tag[0] === 'd' && tag[1] === 'ncc-browser/passwords/v1')
      )
    )
    check(
      'never publishes plaintext credentials',
      vaultEvents.every((entry) => !/alice|s3cret|n3wpass|imported-pass/.test(entry.content))
    )

    const privateTabId = await evaluate(
      chrome,
      `window.ncc.newPrivateTab(${JSON.stringify(`ncc://${serviceNpub}/web/login`)})`
    )
    await sleep(800)
    const privateContext = await evaluate(chrome, 'window.ncc.passwordsContext()')
    check(
      'disables passwords in private tabs',
      privateContext?.tabKind === 'private' && privateContext?.matches.length === 0,
      JSON.stringify(privateContext)
    )
    await evaluate(chrome, `window.ncc.closeTab(${JSON.stringify(privateTabId)})`)
    await evaluate(chrome, 'window.ncc.setAppearance({ theme: "light" })')
    await cdp.send('Page.navigate', { url: `ncc://${missingNpub}/web/` })
    await waitForText(cdp, 'No locator published', 100)

    // Prove relay recovery on the next launch by dropping the ciphertext cache.
    rmSync(join(userData, 'passwords.json'), { force: true })

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
          NCC_DOWNLOAD_DIR: join(configHome, 'downloads'),
          NCC_PASSWORDS_IMPORT: passwordImportPath,
          NCC_PASSWORDS_EXPORT: passwordExportDir,
          NCC_EXTENSION_DIR: join(ROOT, 'test/fixtures/hello-extension')
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
    check(
      'never restores a private tab',
      Array.isArray(restoredState?.tabs) &&
        restoredState.tabs.every((tab) => tab.kind === 'normal') &&
        !JSON.stringify(restoredState.tabs).includes('private-restore'),
      JSON.stringify(restoredState?.tabs)
    )

    const restoredAppearance = await evaluate(
      restoredChrome,
      'JSON.stringify({ ...document.documentElement.dataset })'
    )
    const restoredAppearanceValue = JSON.parse(String(restoredAppearance))
    check(
      'restores appearance settings on the next launch',
      restoredAppearanceValue.theme === 'light' &&
        restoredAppearanceValue.textSize === 'xlarge' &&
        restoredAppearanceValue.accent === 'green' &&
        restoredAppearanceValue.density === 'compact' &&
        restoredAppearanceValue.reduceMotion === 'true',
      String(restoredAppearance)
    )
    check(
      'applies the saved theme to prefers-color-scheme',
      (await evaluate(
        restoredChrome,
        'matchMedia("(prefers-color-scheme: light)").matches'
      )) === true
    )

    const restoredPasswords = await evaluate(
      restoredChrome,
      'window.ncc.passwordsUnlock().then(() => window.ncc.passwordsList())'
    )
    const restoredExtensions = await evaluate(
      restoredChrome,
      'window.ncc.extensionsState().then((state) => state.extensions)'
    )
    check(
      'restores installed extensions on the next launch',
      Array.isArray(restoredExtensions) &&
        restoredExtensions.length === 1 &&
        restoredExtensions[0].name === 'Hello NCC' &&
        restoredExtensions[0].enabled === true,
      JSON.stringify(restoredExtensions)
    )

    check(
      'restores passwords from the relay on the next launch',
      Array.isArray(restoredPasswords) &&
        restoredPasswords.some(
          (entry) => entry.origin.endsWith('/web') && entry.username === 'alice'
        ) &&
        restoredPasswords.some((entry) => entry.origin === 'https://imported.example'),
      JSON.stringify(restoredPasswords?.map((entry) => entry.origin))
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
    const restoredBackground = await evaluate(
      restoredCdp,
      'getComputedStyle(document.body).backgroundColor'
    )
    check(
      'the error page follows the saved theme',
      restoredBackground === 'rgb(242, 244, 248)',
      String(restoredBackground)
    )
    restoredCdp.close()
    restoredChrome.close()
  } catch (error) {
    console.error('--- electron output (debug) ---')
    console.error(logs.slice(-8000))
    throw error
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
