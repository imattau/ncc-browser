import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationController } from '../src/main/automation/controller'
import { AutomationSettings } from '../src/main/automation/settings'
import type { AutomationHost } from '../src/main/automation/types'
import type { AutomationState } from '../src/shared/automation'

const host: AutomationHost = {
  listTabs: () => [],
  newTab: () => 't1',
  closeTab: () => undefined,
  selectTab: () => undefined,
  navigate: async () => undefined,
  history: async () => undefined,
  contents: () => null
}

const dir = () => mkdtempSync(join(tmpdir(), 'ncc-ctl-'))

describe('AutomationSettings', () => {
  it('creates a stable token and persists the preference', () => {
    const file = join(dir(), 's.json')
    const first = new AutomationSettings(file)
    const token = first.token
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(first.enabled).toBe(false)
    first.setEnabled(true)

    const second = new AutomationSettings(file)
    expect(second.token).toBe(token)
    expect(second.enabled).toBe(true)
    expect(second.regenerateToken()).not.toBe(token)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('recovers from a corrupt file', () => {
    const file = join(dir(), 's.json')
    new AutomationSettings(file).setEnabled(true)
    writeFileSync(file, '{nope')
    const settings = new AutomationSettings(file)
    expect(settings.enabled).toBe(false)
    expect(settings.token).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('AutomationController', () => {
  const running: AutomationController[] = []
  afterEach(() => running.splice(0).forEach((c) => c.shutdown()))

  function make(options: { forced?: boolean } = {}) {
    const base = dir()
    const states: AutomationState[] = []
    const settings = new AutomationSettings(join(base, 's.json'))
    const controller = new AutomationController({
      settings,
      host,
      approvals: { request: async () => ({ allow: true, remember: true }) },
      version: '0',
      infoFile: join(base, 'automation.json'),
      forced: options.forced ?? false,
      port: 0,
      onChange: (state) => states.push(state)
    })
    running.push(controller)
    return { controller, settings, states, infoFile: join(base, 'automation.json') }
  }

  it('is off until enabled, then serves with the saved token', async () => {
    const { controller, settings, infoFile } = make()
    await controller.sync()
    expect(controller.state().running).toBe(false)
    expect(controller.connectCommand()).toBeNull()

    const state = await controller.setEnabled(true)
    expect(state.running).toBe(true)
    expect(state.tokenHint).toBe(settings.token.slice(-4))
    expect(controller.connectCommand()).toContain(`Bearer ${settings.token}`)
    expect(JSON.parse(readFileSync(infoFile, 'utf8')).token).toBe(settings.token)

    const res = await fetch(state.url as string, {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(res.status).toBe(200)
  })

  it('stops listening and removes the info file when disabled', async () => {
    const { controller, infoFile } = make()
    const url = (await controller.setEnabled(true)).url as string
    await controller.setEnabled(false)
    expect(controller.state().running).toBe(false)
    expect(existsSync(infoFile)).toBe(false)
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
  })

  it('regenerating the token cuts off the old one', async () => {
    const { controller, settings } = make()
    const state = await controller.setEnabled(true)
    const old = settings.token
    controller.regenerateToken()
    expect(settings.token).not.toBe(old)
    const post = (token: string) =>
      fetch(state.url as string, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      })
    expect((await post(old)).status).toBe(401)
    expect((await post(settings.token)).status).toBe(200)
  })

  it('runs when forced even though the preference is off', async () => {
    const { controller } = make({ forced: true })
    await controller.sync()
    expect(controller.state()).toMatchObject({ running: true, enabled: false, forced: true })
  })

  it('publishes state changes', async () => {
    const { controller, states } = make()
    await controller.setEnabled(true)
    controller.revoke(null)
    expect(states.length).toBeGreaterThanOrEqual(2)
    expect(states.at(-1)?.running).toBe(true)
  })
})
