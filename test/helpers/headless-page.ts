import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

/**
 * A real browser page with trusted mouse and keyboard input. Page scripts that act
 * only on `isTrusted` events, and that depend on layout, cannot be tested otherwise.
 */
export function findChrome(): string | null {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  const cache = join(homedir(), '.cache/ms-playwright')
  if (existsSync(cache)) {
    for (const name of readdirSync(cache).filter((entry) => entry.startsWith('chromium_headless_shell-')).sort().reverse()) {
      candidates.push(join(cache, name, 'chrome-headless-shell-linux64/chrome-headless-shell'))
    }
  }
  return candidates.find((path): path is string => !!path && existsSync(path)) ?? null
}

export interface HeadlessPage<Message> {
  messages: Message[]
  load(html: string): Promise<void>
  run<T = unknown>(expression: string): Promise<T>
  /** `>>>` in a selector steps into an open shadow root. */
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  enter(): Promise<void>
  value(selector: string): Promise<string>
  sleep(ms: number): Promise<void>
  close(): void
}

const resolveSelector = (selector: string): string =>
  `(()=>{let r=document,e;for(const s of ${JSON.stringify(selector)}.split('>>>')){e=r.querySelector(s.trim());r=e.shadowRoot}return e})()`

/** Pages call `report(JSON.stringify(...))`; the values arrive in `messages`. */
export async function openHeadlessPage<Message>(binary: string): Promise<HeadlessPage<Message>> {
  const pages = new Map<string, string>()
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(pages.get((request.url ?? '').split('?')[0]) ?? '<p>done</p>')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  const profile = mkdtempSync(join(tmpdir(), 'ncc-headless-'))
  const flags = ['--headless', '--remote-debugging-pipe', '--no-first-run', `--user-data-dir=${profile}`]
  if (process.env.CI) flags.push('--no-sandbox')
  const chrome = spawn(binary, flags, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const input = chrome.stdio[3] as Writable
  const output = chrome.stdio[4] as Readable

  type Reply = { id?: number; method?: string; params?: { payload: string }; result?: any }
  const waiting = new Map<number, (reply: Reply) => void>()
  const messages: Message[] = []
  let nextId = 0
  let buffer = ''
  let sessionId: string | undefined
  output.on('data', (chunk) => {
    buffer += chunk
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const reply = JSON.parse(buffer.slice(0, end)) as Reply
      buffer = buffer.slice(end + 1)
      if (reply.method === 'Runtime.bindingCalled') messages.push(JSON.parse(reply.params!.payload) as Message)
      if (reply.id !== undefined) waiting.get(reply.id)?.(reply)
    }
  })
  const send = (method: string, params: object = {}): Promise<Reply> =>
    new Promise((done) => {
      waiting.set(++nextId, done)
      input.write(JSON.stringify({ id: nextId, method, params, sessionId }) + '\0')
    })
  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

  const target = await send('Target.createTarget', { url: 'about:blank' })
  sessionId = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Runtime.addBinding', { name: 'report' })

  const run = async <T>(expression: string): Promise<T> => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception.description)
    return reply.result.result.value as T
  }
  const click = async (selector: string): Promise<void> => {
    const [x, y] = await run<[number, number]>(
      `(()=>{const b=${resolveSelector(selector)}.getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`
    )
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
    await sleep(80)
  }

  return {
    messages,
    run,
    click,
    sleep,
    async load(html) {
      const path = `/p${pages.size}`
      pages.set(path, `<!doctype html><body>${html}`)
      messages.length = 0
      await send('Page.navigate', { url: base + path })
      for (let tries = 0; tries < 100; tries++) {
        await sleep(30)
        if (await run<boolean>(`location.pathname === '${path}' && document.readyState === 'complete'`).catch(() => false)) break
      }
      messages.length = 0
    },
    async type(selector, text) {
      await click(selector)
      await send('Input.insertText', { text })
      await sleep(40)
    },
    async enter() {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      await sleep(80)
    },
    value: (selector) => run<string>(`${resolveSelector(selector)}.value`),
    close() {
      chrome.kill()
      server.close()
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        // Chrome can still be writing as it exits; the directory is in tmp.
      }
    }
  }
}
