#!/usr/bin/env node
/**
 * End-to-end smoke test for hosted services and site publishing: real Electron
 * window, local `nak` relay, a local Blossom stand-in, a development identity, and
 * the actual Settings UI driven over CDP.
 *
 * Covers: Services create/publish/share, the native Sites scan/upload/sign/publish
 * flow, the persisted JSON files, and the standalone `nccpublish://app` page with the
 * built-in signer.
 *
 * Run: npm run build && node scripts/e2e-hosting-smoke.mjs
 * Needs: Xvfb, nak, and free 10548 / 10550 / 9333 ports.
 * `NCC_NSITE_FOLDER` is a test-only hook that replaces the native folder dialog.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = '/tmp/opencode/ncc-hosting-smoke'
const DISPLAY = ':98'
const CDP_PORT = 9333
const RELAY_PORT = 10548
const BLOSSOM_PORT = 10550
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(...args) {
  console.log('[smoke]', ...args)
}

function start(command, args, env = {}) {
  const proc = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (chunk) => process.env.SMOKE_VERBOSE && process.stdout.write(chunk))
  proc.stderr.on('data', (chunk) => process.env.SMOKE_VERBOSE && process.stderr.write(chunk))
  return proc
}

async function waitForHttp(url, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
    } catch {}
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${url}`)
}


async function waitForChromeTarget(timeout = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const chrome = targets.find(
        (target) => target.type === 'page' && target.url.includes('out/renderer/index.html')
      )
      if (chrome) return chrome
    } catch {
      // Electron is still starting.
    }
    await sleep(200)
  }
  throw new Error('chrome target not found')
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.next = 1
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (data) => {
      const message = JSON.parse(String(data))
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  async send(method, params = {}) {
    await this.ready
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed')
    }
    return result.result.value
  }

  close() {
    this.ws.close()
  }
}

async function waitFor(cdp, expression, label, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await cdp.evaluate(expression)) return
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const secret = generateSecretKey()
const secretHex = Buffer.from(secret).toString('hex')
const contactA = generateSecretKey()
const contactB = generateSecretKey()
const contactAHex = getPublicKey(contactA)
const contactBHex = getPublicKey(contactB)
const recipient = nip19.npubEncode(getPublicKey(generateSecretKey()))

mkdirSync(SCRATCH, { recursive: true })
const userData = join(SCRATCH, 'config', 'NCC Browser')
mkdirSync(userData, { recursive: true })
const siteFolder = join(SCRATCH, 'site')
mkdirSync(join(siteFolder, 'assets'), { recursive: true })
writeFileSync(join(siteFolder, 'index.html'), '<!doctype html><h1>Smoke site</h1>')
writeFileSync(join(siteFolder, 'assets', 'app.js'), 'console.log("smoke")')
const blobs = new Map()
const blossom = createServer((request, response) => {
  const url = request.url ?? '/'
  if (request.method === 'HEAD' && url.startsWith('/')) {
    response.writeHead(blobs.has(url.slice(1)) ? 200 : 404).end()
    return
  }
  if (request.method === 'PUT' && url === '/upload') {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      blobs.set(createHash('sha256').update(body).digest('hex'), body)
      response.writeHead(200).end()
    })
    return
  }
  if (request.method === 'GET' && url.startsWith('/')) {
    const body = blobs.get(url.slice(1))
    response.writeHead(body ? 200 : 404).end(body)
    return
  }
  response.writeHead(404).end()
})
await new Promise((resolve) => blossom.listen(BLOSSOM_PORT, '127.0.0.1', resolve))
writeFileSync(
  join(userData, 'config.json'),
  JSON.stringify({ relays: [{ url: `ws://127.0.0.1:${RELAY_PORT}` }], gossip: false })
)

start('Xvfb', [DISPLAY, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'])
const relay = start('nak', ['serve', '--port', String(RELAY_PORT)])
await sleep(800)
const seed = new SimplePool()
const relayUrl = `ws://127.0.0.1:${RELAY_PORT}`
const now = Math.floor(Date.now() / 1000)
await seed.publish(
  [relayUrl],
  finalizeEvent(
    {
      kind: 3,
      created_at: now,
      tags: [['p', contactAHex], ['p', contactBHex]],
      content: ''
    },
    secret
  )
)
for (const [contactSecret, name] of [
  [contactA, 'alice'],
  [contactB, 'bob']
]) {
  await seed.publish(
    [relayUrl],
    finalizeEvent(
      {
        kind: 0,
        created_at: now,
        tags: [],
        content: JSON.stringify({ name, display_name: `${name} Display`, nip05: `${name}@example.com` })
      },
      contactSecret
    )
  )
}
await sleep(400)

const electron = start(
  join(ROOT, 'node_modules/.bin/electron'),
  ['.', `--remote-debugging-port=${CDP_PORT}`],
  {
    DISPLAY,
    XDG_CONFIG_HOME: join(SCRATCH, 'config'),
    XDG_DATA_HOME: join(SCRATCH, 'data'),
    XDG_CACHE_HOME: join(SCRATCH, 'cache'),
    NCC_IDENTITY_NSEC: secretHex,
    NCC_SIGNER_AUTO_APPROVE: '1',
    NCC_NSITE_FOLDER: siteFolder
  }
)

let cdp
try {
  const chrome = await waitForChromeTarget()
  cdp = new Cdp(chrome.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await waitFor(cdp, 'Boolean(window.ncc)', 'preload API')
  log('chrome loaded')

  let opened = false
  for (let attempt = 0; attempt < 25 && !opened; attempt += 1) {
    await cdp.evaluate("window.ncc.runCommand('open-services')")
    await sleep(200)
    opened = await cdp.evaluate("Boolean(document.querySelector('[data-hosting-settings]'))")
  }
  if (!opened) {
    console.log('DOM', await cdp.evaluate(`JSON.stringify({
      settings: Boolean(document.querySelector('[data-settings-page]')),
      servicesSection: Boolean(document.querySelector('[data-settings-section="services"]')),
      hosting: Boolean(document.querySelector('[data-hosting-settings]')),
      text: document.body.innerText.slice(0, 800)
    })`))
    throw new Error('services page did not open')
  }
  log('services page open')

  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add service')
    button?.click()
    return Boolean(button)
  })()`)
  await waitFor(cdp, "Boolean(document.querySelector('[data-hosting-settings] form'))", 'service form')

  await cdp.evaluate(`(() => {
    const form = document.querySelector('[data-hosting-settings] form')
    const textarea = form.querySelector('textarea')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      textarea,
      'http://127.0.0.1:${BLOSSOM_PORT}/'
    )
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    form.querySelector('[data-discover-endpoints]')?.click()
    return true
  })()`)
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-endpoint-candidate]').length >= 2",
    'discovered endpoints',
    15000
  )
  const discovered = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-endpoint-candidate]')]
    return rows.map((row) => row.getAttribute('data-endpoint-candidate'))
  })()`)
  if (!discovered.some((url) => url.includes('127.0.0.1'))) {
    throw new Error(`loopback endpoint was not discovered: ${discovered.join(', ')}`)
  }
  const picked = discovered.find((url) => url.includes('localhost')) ?? discovered[0]
  await cdp.evaluate(`(() => {
    const row = document.querySelector('[data-endpoint-candidate=${JSON.stringify(picked)}]')
    row?.querySelector('input')?.click()
    return true
  })()`)
  await sleep(150)
  const selected = await cdp.evaluate(
    "document.querySelector('[data-hosting-settings] form textarea').value"
  )
  if (!selected.includes(picked)) {
    throw new Error(`selecting ${picked} did not fill the endpoints field: ${selected}`)
  }
  log('endpoints discovered', discovered.length)

  await cdp.evaluate(`(() => {
    const form = document.querySelector('[data-hosting-settings] form')
    const set = (element, value) => {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(form.querySelector('input[placeholder="Photos"]'), 'Photos')
    set(form.querySelector('textarea'), 'https://photos.example\\nhttp://127.0.0.1:${BLOSSOM_PORT}')
    return true
  })()`)
  await sleep(100)
  await cdp.evaluate(`(() => {
    const form = document.querySelector('[data-hosting-settings] form')
    const button = [...form.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add service')
    button?.click()
    return Boolean(button)
  })()`)
  await waitFor(cdp, "Boolean(document.querySelector('[data-hosting-service=\"photos\"]'))", 'service card')
  const onionReady = await cdp.evaluate(
    "Boolean(document.querySelector('[data-hosting-service=\"photos\"] [data-publish-onion]'))"
  )
  if (!onionReady) throw new Error('the onion action was not offered for a loopback endpoint')
  log('service created')

  await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-hosting-service="photos"]')
    const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Publish')
    button?.click()
    return Boolean(button)
  })()`)
  await waitFor(
    cdp,
    `(() => {
      const card = document.querySelector('[data-hosting-service="photos"]')
      if (!card) return false
      return [...card.querySelectorAll('span')].some((span) => /^published /.test(span.textContent.trim()))
    })()`,
    'published badge',
    20000
  )
  log('service published')

  await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-hosting-service="photos"]')
    const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Share')
    button?.click()
    return Boolean(button)
  })()`)
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-contact]').length >= 2",
    'contacts',
    15000
  )
  await cdp.evaluate(`(() => {
    for (const pubkey of [${JSON.stringify(contactAHex)}, ${JSON.stringify(contactBHex)}]) {
      document.querySelector('[data-contact="' + pubkey + '"] input')?.click()
    }
    return true
  })()`)
  await sleep(200)
  await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-hosting-service="photos"]')
    const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Create'))
    button?.click()
    return Boolean(button)
  })()`)
  await waitFor(
    cdp,
    "document.querySelectorAll('[data-share-result]').length >= 2",
    'two share links',
    30000
  )
  await waitFor(
    cdp,
    `(() => {
      const card = document.querySelector('[data-hosting-service="photos"]')
      return Boolean(card && card.textContent.includes('ncc://') && card.textContent.includes('/share-'))
    })()`,
    'share link',
    20000
  )
  log('private share published')

  const servicesFile = join(userData, 'services.json')
  if (!existsSync(servicesFile)) throw new Error('services.json was not written')
  const state = JSON.parse(readFileSync(servicesFile, 'utf8'))
  if (state.services.length !== 1) throw new Error('service was not stored')
  if (state.shares.length !== 2) throw new Error('both shares were not stored')
  log('state file ok', JSON.stringify({ services: state.services.length, shares: state.shares.length }))

  let sitesOpen = false
  for (let attempt = 0; attempt < 25 && !sitesOpen; attempt += 1) {
    await cdp.evaluate("window.ncc.runCommand('open-site-publisher')")
    await sleep(200)
    sitesOpen = await cdp.evaluate("Boolean(document.querySelector('[data-nsite-settings]'))")
  }
  if (!sitesOpen) throw new Error('Sites settings did not open')
  log('sites settings open')

  await cdp.evaluate("document.querySelector('[data-nsite-pick]').click()")
  await waitFor(cdp, "Boolean(document.querySelector('[data-nsite-publish]'))", 'site scan', 15000)
  const setField = (selector, value) =>
    cdp.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)})
      if (!element) return false
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(value)})
      element.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  await setField('[data-nsite-site-id]', 'smoke-site')
  await setField('[data-nsite-title]', 'Smoke site')
  await setField('[data-nsite-servers]', `http://127.0.0.1:${BLOSSOM_PORT}`)
  await setField('[data-nsite-relays]', `ws://127.0.0.1:${RELAY_PORT}`)
  await sleep(200)
  await cdp.evaluate("document.querySelector('[data-nsite-publish]').click()")
  await waitFor(
    cdp,
    "Boolean(document.querySelector('[data-nsite-site=\"smoke-site\"]'))",
    'published site',
    30000
  )
  log('native site published')
  if (blobs.size < 2) throw new Error(`expected at least 2 uploaded blobs, got ${blobs.size}`)
  const sitesFile = join(userData, 'nsite-sites.json')
  if (!existsSync(sitesFile)) throw new Error('nsite-sites.json was not written')
  const sites = JSON.parse(readFileSync(sitesFile, 'utf8'))
  if (sites.sites.length !== 1) throw new Error('site was not stored')
  await sleep(400)
  const pool = new SimplePool()
  const manifests = await pool.querySync([`ws://127.0.0.1:${RELAY_PORT}`], {
    kinds: [35128],
    authors: [getPublicKey(secret)],
    '#d': ['smoke-site']
  })
  if (manifests.length !== 1) throw new Error(`expected one manifest, got ${manifests.length}`)
  log('manifest published to the relay', manifests[0].id.slice(0, 12))

  await cdp.evaluate("window.ncc.newTab('nccpublish://app/')")
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const allTargets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const publisherTarget = allTargets.find(
    (target) => target.type === 'page' && target.url.startsWith('nccpublish://app')
  )
  if (!publisherTarget) {
    throw new Error(`site publisher target not found: ${JSON.stringify(allTargets.map((t) => t.url))}`)
  }
  const publisher = new Cdp(publisherTarget.webSocketDebuggerUrl)
  await publisher.send('Runtime.enable')
  await waitFor(publisher, "Boolean(document.querySelector('h1'))", 'publisher heading', 15000)
  const heading = await publisher.evaluate("document.querySelector('h1').textContent.trim()")
  if (!heading.includes('Publish a site')) throw new Error(`unexpected heading: ${heading}`)
  await waitFor(publisher, 'Boolean(window.nostr)', 'publisher signer', 15000)
  const publisherKey = await publisher.evaluate('window.nostr.getPublicKey()')
  if (!/^[0-9a-f]{64}$/.test(publisherKey)) {
    throw new Error(`publisher signer returned an unexpected key: ${publisherKey}`)
  }
  publisher.close()
  log('site publisher loaded with its signer')

  console.log('SMOKE OK')
} finally {
  try {
    cdp?.close()
  } catch {}
  electron.kill('SIGTERM')
  relay.kill('SIGTERM')
  blossom.close()
  spawn('pkill', ['-f', `Xvfb ${DISPLAY}`])
}
