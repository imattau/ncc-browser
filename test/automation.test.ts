import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpHandler } from '../src/main/automation/mcp'
import { AutomationServer } from '../src/main/automation/server'
import { ApprovalGate } from '../src/main/automation/gate'
import { siteOf } from '../src/main/automation/site'
import type {
  AutomationContents,
  AutomationGate,
  AutomationHost
} from '../src/main/automation/types'
import type { SignerDecision } from '../src/shared/types'

const allowAll: AutomationGate = { authorize: async () => true }

function fakeHost() {
  const calls: string[] = []
  const contents: AutomationContents = {
    evaluate: async (code) => {
      calls.push('eval')
      return code.includes('getBoundingClientRect') ? { x: 10, y: 20 } : { ok: true }
    },
    screenshot: async () => Buffer.from('png'),
    click: async (x, y) => void calls.push(`click ${x},${y}`),
    hover: async () => undefined,
    insertText: async (t) => void calls.push(`type ${t}`),
    pressKey: async (k) => void calls.push(`key ${k}`),
    diagnostics: () => []
  }
  const host: AutomationHost = {
    listTabs: () => [{ tabId: 't1', url: 'https://example.com/', title: 'Example', active: true }],
    newTab: () => 't2',
    closeTab: () => undefined,
    selectTab: (id) => void calls.push(`select ${id}`),
    navigate: async () => undefined,
    history: async () => undefined,
    contents: (id) => (id === 't1' ? contents : null)
  }
  return { host, calls }
}

const rpc = (method: string, params?: unknown, id = 1) => ({ jsonrpc: '2.0', id, method, params })

describe('McpHandler', () => {
  const info = { name: 'test', version: '0' }

  it('initialises and lists tools', async () => {
    const handler = new McpHandler(fakeHost().host, allowAll, info)
    const init = await handler.handle(rpc('initialize', { protocolVersion: '2025-03-26' }))
    expect((init?.result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26')
    const list = await handler.handle(rpc('tools/list'))
    const names = (list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['tabs_list', 'screenshot', 'click', 'type']))
  })

  it('treats notifications as one-way', async () => {
    const handler = new McpHandler(fakeHost().host, allowAll, info)
    expect(await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('runs click by coordinates and by ref', async () => {
    const { host, calls } = fakeHost()
    const handler = new McpHandler(host, allowAll, info)
    await handler.handle(rpc('tools/call', { name: 'click', arguments: { x: 5, y: 6 } }))
    await handler.handle(rpc('tools/call', { name: 'click', arguments: { ref: 'e1' } }))
    expect(calls).toContain('click 5,6')
    expect(calls).toContain('click 10,20')
  })

  it('returns screenshots as image content', async () => {
    const handler = new McpHandler(fakeHost().host, allowAll, info)
    const reply = await handler.handle(rpc('tools/call', { name: 'screenshot', arguments: {} }))
    const content = (reply?.result as { content: Array<{ type: string; data: string }> }).content
    expect(content[0]?.type).toBe('image')
    expect(Buffer.from(content[0]!.data, 'base64').toString()).toBe('png')
  })

  it('returns console diagnostics for the granted site only', async () => {
    const base = fakeHost()
    const contents = base.host.contents('t1')!
    const host: AutomationHost = {
      ...base.host,
      contents: (id) =>
        id === 't1'
          ? {
              ...contents,
              diagnostics: () => [
                { time: 't', kind: 'console', level: 'error', message: 'own', url: '', line: 1 },
                {
                  time: 't',
                  kind: 'console',
                  level: 'error',
                  message: 'same',
                  url: 'https://example.com/app.js',
                  line: 2
                },
                {
                  time: 't',
                  kind: 'console',
                  level: 'error',
                  message: 'other',
                  url: 'https://other.example/x.js',
                  line: 3
                }
              ]
            }
          : null
    }
    const handler = new McpHandler(host, allowAll, info)
    const reply = await handler.handle(
      rpc('tools/call', { name: 'get_console_logs', arguments: { limit: 10 } })
    )
    const text = (reply?.result as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('own')
    expect(text).toContain('same')
    expect(text).not.toContain('other')
  })

  it('refuses unknown tabs and unknown tools', async () => {
    const handler = new McpHandler(fakeHost().host, allowAll, info)
    const bad = await handler.handle(
      rpc('tools/call', { name: 'get_page_text', arguments: { tabId: 'private-1' } })
    )
    expect((bad?.result as { isError?: boolean }).isError).toBe(true)
    const unknown = await handler.handle(rpc('tools/call', { name: 'nope' }))
    expect(unknown?.error?.code).toBe(-32602)
  })
})

describe('AutomationServer', () => {
  let server: AutomationServer | null = null
  afterEach(() => server?.stop())

  async function boot() {
    const infoFile = join(mkdtempSync(join(tmpdir(), 'ncc-auto-')), 'automation.json')
    server = new AutomationServer({ host: fakeHost().host, gate: allowAll, version: '0', infoFile })
    const url = await server.start()
    const { token } = JSON.parse(readFileSync(infoFile, 'utf8')) as { token: string }
    return { url, token }
  }

  const post = (url: string, headers: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(rpc('tools/list'))
    })

  it('requires the bearer token', async () => {
    const { url, token } = await boot()
    expect((await post(url, {})).status).toBe(401)
    expect((await post(url, { authorization: 'Bearer wrong' })).status).toBe(401)
    const ok = await post(url, { authorization: `Bearer ${token}` })
    expect(ok.status).toBe(200)
  })

  it('rejects browser-originated requests', async () => {
    const { url, token } = await boot()
    const res = await post(url, { authorization: `Bearer ${token}`, origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })
})

const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'

describe('siteOf', () => {
  it('reduces addresses to the unit a user grants', () => {
    expect(siteOf('https://example.com/a/b?q=1')).toBe('https://example.com')
    expect(siteOf('example.com/x')).toBe('https://example.com')
    expect(siteOf(`ncc://${NPUB}/web/docs`)).toBe(`ncc://${NPUB}/web`)
    expect(siteOf(`nsite://${NPUB}/`)).toBe(`nsite://${NPUB}`)
  })

  it('reduces the host form the content view loads to the same service', () => {
    expect(siteOf(`ncc://${NPUB}.web/assets/app.js`)).toBe(`ncc://${NPUB}/web`)
    expect(siteOf(`ncc://${NPUB}.web/`)).toBe(`ncc://${NPUB}/web`)
    expect(siteOf(`ncc://${NPUB}.other/docs`)).toBe(`ncc://${NPUB}/other`)
    expect(siteOf(`nsite://${NPUB}.blog/assets/app.js`)).toBe(`nsite://${NPUB}/blog`)
    expect(siteOf(`nsite://${NPUB}.blog/`)).toBe(`nsite://${NPUB}/blog`)
  })

  it('keeps one service on either form comparable', () => {
    expect(siteOf(`ncc://${NPUB}.web/assets/x.js`)).toBe(siteOf(`ncc://${NPUB}/web/`))
    expect(siteOf(`nsite://${NPUB}.blog/index.html`)).toBe(siteOf(`nsite://${NPUB}/blog/`))
  })
})

describe('ApprovalGate', () => {
  function gate(decide: (n: number) => SignerDecision) {
    let asked = 0
    const requests: Array<{ kind?: string; service: string }> = []
    const instance = new ApprovalGate({
      request: async (request) => {
        requests.push(request)
        return decide(++asked)
      }
    })
    return { instance, requests, count: () => asked }
  }

  it('asks once per site when remembered for the session', async () => {
    const { instance, requests, count } = gate(() => ({ allow: true, remember: true }))
    expect(await instance.authorize('https://a.test', 'click')).toBe(true)
    expect(await instance.authorize('https://a.test', 'type')).toBe(true)
    expect(count()).toBe(1)
    expect(requests[0]?.kind).toBe('automation')
    await instance.authorize('https://b.test', 'click')
    expect(count()).toBe(2)
  })

  it('does not remember a plain allow or a denial', async () => {
    const once = gate(() => ({ allow: true, remember: false }))
    await once.instance.authorize('https://a.test', 'click')
    await once.instance.authorize('https://a.test', 'click')
    expect(once.count()).toBe(2)

    const denied = gate(() => ({ allow: false, remember: true }))
    expect(await denied.instance.authorize('https://a.test', 'click')).toBe(false)
    expect(await denied.instance.authorize('https://a.test', 'click')).toBe(false)
    expect(denied.count()).toBe(2)
  })

  it('shares one prompt between concurrent calls', async () => {
    const { instance, count } = gate(() => ({ allow: true, remember: false }))
    await Promise.all([
      instance.authorize('https://a.test', 'click'),
      instance.authorize('https://a.test', 'type')
    ])
    expect(count()).toBe(1)
  })

  it('blocks tool calls when the gate denies', async () => {
    const handler = new McpHandler(fakeHost().host, { authorize: async () => false }, {
      name: 't',
      version: '0'
    })
    const reply = await handler.handle(rpc('tools/call', { name: 'click', arguments: { x: 1, y: 1 } }))
    const result = reply?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('did not allow')
  })
})

describe('keyEvents', () => {
  it('sends a char event for Enter so forms submit', async () => {
    const { keyEvents } = await import('../src/main/automation/key-events')
    expect(keyEvents('Enter', [])).toEqual([
      { type: 'keyDown', keyCode: 'Enter' },
      { type: 'char', keyCode: '\r' },
      { type: 'keyUp', keyCode: 'Enter' }
    ])
    expect(keyEvents('a', []).map((e) => e.type)).toEqual(['keyDown', 'char', 'keyUp'])
    expect(keyEvents('Escape', []).map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
    expect(keyEvents('a', ['control']).map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
  })
})
