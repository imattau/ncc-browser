#!/usr/bin/env node
/**
 * End-to-end smoke test for hosted services: real Electron window, local `nak` relay,
 * a development identity, and the actual Settings → Services UI driven over CDP.
 *
 * Covers: opening Services, creating a private service, publishing it, sharing it with
 * an npub, and the persisted `services.json`.
 *
 * Run: npm run build && node scripts/e2e-hosting-smoke.mjs
 * Needs: Xvfb, nak, and a free 10548 / 9333 port.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = '/tmp/opencode/ncc-hosting-smoke'
const DISPLAY = ':98'
const CDP_PORT = 9333
const RELAY_PORT = 10548
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
const recipient = nip19.npubEncode(getPublicKey(generateSecretKey()))

mkdirSync(SCRATCH, { recursive: true })
const userData = join(SCRATCH, 'config', 'NCC Browser')
mkdirSync(userData, { recursive: true })
writeFileSync(
  join(userData, 'config.json'),
  JSON.stringify({ relays: [{ url: `ws://127.0.0.1:${RELAY_PORT}` }], gossip: false })
)

start('Xvfb', [DISPLAY, '-screen', '0', '1440x900x24', '-nolisten', 'tcp'])
const relay = start('nak', ['serve', '--port', String(RELAY_PORT)])
await sleep(800)

const electron = start(
  join(ROOT, 'node_modules/.bin/electron'),
  ['.', `--remote-debugging-port=${CDP_PORT}`],
  {
    DISPLAY,
    XDG_CONFIG_HOME: join(SCRATCH, 'config'),
    XDG_DATA_HOME: join(SCRATCH, 'data'),
    XDG_CACHE_HOME: join(SCRATCH, 'cache'),
    NCC_IDENTITY_NSEC: secretHex,
    NCC_SIGNER_AUTO_APPROVE: '1'
  }
)

let cdp
try {
  const targets = await waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const chrome = targets.find((target) => target.type === 'page' && target.url.includes('out/renderer/index.html'))
  if (!chrome) throw new Error(`chrome target not found: ${JSON.stringify(targets.map((t) => t.url))}`)
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
    const set = (element, value) => {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set(form.querySelector('input[placeholder="Photos"]'), 'Photos')
    set(form.querySelector('textarea'), 'https://photos.example')
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
  await sleep(100)
  await cdp.evaluate(`(() => {
    const form = document.querySelector('[data-hosting-service="photos"]')
    const input = form.querySelector('input[placeholder^="npub1"]')
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, ${JSON.stringify(recipient)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(100)
  await cdp.evaluate(`(() => {
    const card = document.querySelector('[data-hosting-service="photos"]')
    const button = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Create link')
    button?.click()
    return Boolean(button)
  })()`)
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
  if (state.shares.length !== 1) throw new Error('share was not stored')
  log('state file ok', JSON.stringify({ services: state.services.length, shares: state.shares.length }))
  console.log('SMOKE OK')
} finally {
  try {
    cdp?.close()
  } catch {}
  electron.kill('SIGTERM')
  relay.kill('SIGTERM')
  spawn('pkill', ['-f', `Xvfb ${DISPLAY}`])
}
