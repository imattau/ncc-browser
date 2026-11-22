import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AutomationController, type AutomationPasswordsLike } from '../src/main/automation/controller'
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

function fakePasswords(unlocked = true): AutomationPasswordsLike & { saved: Array<{ id: string; nsec: string }> } {
  const saved: Array<{ id: string; nsec: string }> = []
  return {
    saved,
    status: () => ({ unlocked }),
    saveAgentSecret: async (id, _name, _npub, nsec) => {
      saved.push({ id, nsec })
      return { ok: true }
    },
    removeEntry: async () => ({ ok: true })
  }
}

const dir = () => mkdtempSync(join(tmpdir(), 'ncc-ctl-'))

describe('AutomationSettings', () => {
  it('creates agents with a stable nsec and persists the preference', () => {
    const file = join(dir(), 's.json')
    const first = new AutomationSettings(file)
    expect(first.enabled).toBe(false)
    first.setEnabled(true)
    const agent = first.addAgent('Claude Code')
    expect(agent.nsec).toMatch(/^nsec1/)
    expect(agent.npub).toMatch(/^npub1/)

    const second = new AutomationSettings(file)
    expect(second.enabled).toBe(true)
    expect(second.agents).toHaveLength(1)
    expect(second.agents[0]?.nsec).toBe(agent.nsec)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)

    const regenerated = second.regenerateIdentity(agent.id)
    expect(regenerated?.nsec).not.toBe(agent.nsec)
    second.removeAgent(agent.id)
    expect(second.agents).toHaveLength(0)
  })

  it('recovers from a corrupt file', () => {
    const file = join(dir(), 's.json')
    new AutomationSettings(file).setEnabled(true)
    writeFileSync(file, '{nope')
    const settings = new AutomationSettings(file)
    expect(settings.enabled).toBe(false)
    expect(settings.agents).toEqual([])
  })

  it('migrates a legacy single-token file into one agent', () => {
    const file = join(dir(), 's.json')
    writeFileSync(file, JSON.stringify({ enabled: true, token: 'a'.repeat(64) }))
    const settings = new AutomationSettings(file)
    expect(settings.agents).toHaveLength(1)
    expect(settings.agents[0]?.nsec).toBe('a'.repeat(64))
    expect(settings.agents[0]?.npub).toBeNull()

    // The migration is persisted: a fresh load no longer sees the legacy shape.
    const reloaded = new AutomationSettings(file)
    expect(reloaded.agents[0]?.id).toBe(settings.agents[0]?.id)
  })
})

describe('AutomationController', () => {
  const running: AutomationController[] = []
  afterEach(() => running.splice(0).forEach((c) => c.shutdown()))

  function make(options: { forced?: boolean; passwords?: AutomationPasswordsLike } = {}) {
    const base = dir()
    const states: AutomationState[] = []
    const settings = new AutomationSettings(join(base, 's.json'))
    const controller = new AutomationController({
      settings,
      host,
      approvals: { request: async () => ({ allow: true, remember: true }) },
      passwords: options.passwords ?? fakePasswords(),
      version: '0',
      infoFile: join(base, 'automation.json'),
      forced: options.forced ?? false,
      port: 0,
      onChange: (state) => states.push(state)
    })
    running.push(controller)
    return { controller, settings, states, infoFile: join(base, 'automation.json') }
  }

  it('is off until enabled, then serves agents added afterwards', async () => {
    const { controller, infoFile } = make()
    await controller.sync()
    expect(controller.state().running).toBe(false)

    await controller.setEnabled(true)
    expect(controller.state().running).toBe(true)
    expect(controller.state().agents).toHaveLength(0)

    const added = await controller.addAgent('Claude Code')
    expect(added.error).toBeNull()
    expect(added.command).toContain('Bearer nsec1')
    const agent = controller.state().agents[0]!
    expect(agent.name).toBe('Claude Code')
    const bearer = added.command!.match(/Bearer (\S+)"/)![1]!
    expect(agent.maskedCommand).not.toContain(bearer)
    expect(existsSync(infoFile)).toBe(true)

    const res = await fetch(controller.state().url as string, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    expect(res.status).toBe(200)
  })

  it('refuses to add an agent while the password vault is locked', async () => {
    const { controller } = make({ passwords: fakePasswords(false) })
    await controller.setEnabled(true)
    const result = await controller.addAgent('Claude Code')
    expect(result.error).toMatch(/unlock/i)
    expect(controller.state().agents).toHaveLength(0)
  })

  it('stops listening and removes the info file when disabled', async () => {
    const { controller, infoFile } = make()
    await controller.setEnabled(true)
    await controller.addAgent('A')
    const url = controller.state().url as string
    await controller.setEnabled(false)
    expect(controller.state().running).toBe(false)
    expect(existsSync(infoFile)).toBe(false)
    await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
  })

  it('regenerating an identity cuts off the old nsec', async () => {
    const { controller } = make()
    await controller.setEnabled(true)
    const added = await controller.addAgent('A')
    const agentId = controller.state().agents[0]!.id
    const oldBearer = added.command!.match(/Bearer (\S+)"/)![1]!
    const url = controller.state().url as string

    const regenerated = await controller.regenerateIdentity(agentId)
    const newBearer = regenerated.command!.match(/Bearer (\S+)"/)![1]!
    expect(newBearer).not.toBe(oldBearer)

    const post = (bearer: string) =>
      fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      })
    expect((await post(oldBearer)).status).toBe(401)
    expect((await post(newBearer)).status).toBe(200)
  })

  it('scopes revoke to one agent', async () => {
    const { controller } = make()
    await controller.setEnabled(true)
    await controller.addAgent('A')
    await controller.addAgent('B')
    const [a, b] = controller.state().agents

    await fetch(controller.state().url as string, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${(await controller.revealCommand(a!.id))!.match(/Bearer (\S+)"/)![1]!}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'click', arguments: { x: 1, y: 1 } } })
    })
    expect(controller.state().agents.find((agent) => agent.id === a!.id)?.grants).toEqual([])
    expect(controller.state().agents.find((agent) => agent.id === b!.id)?.grants).toEqual([])
  })

  it('tracks sign-in grants independently of browsing grants and other agents', async () => {
    const { controller } = make()
    await controller.setEnabled(true)
    await controller.addAgent('A')
    await controller.addAgent('B')
    const [a, b] = controller.state().agents

    const pubkey = await controller.authorizeAndSign(a!.id, 'https://example.com', 'see its public key', (signer) =>
      signer.getPublicKey()
    )
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/)
    expect(controller.state().agents.find((agent) => agent.id === a!.id)?.signGrants).toEqual([
      'https://example.com'
    ])
    expect(controller.state().agents.find((agent) => agent.id === a!.id)?.grants).toEqual([])
    expect(controller.state().agents.find((agent) => agent.id === b!.id)?.signGrants).toEqual([])

    controller.revokeSign(a!.id, 'https://example.com')
    expect(controller.state().agents.find((agent) => agent.id === a!.id)?.signGrants).toEqual([])
  })

  it('refuses to sign for an agent that no longer exists', async () => {
    const { controller } = make()
    await controller.setEnabled(true)
    await expect(
      controller.authorizeAndSign('nope', 'https://example.com', 'x', (signer) => signer.getPublicKey())
    ).rejects.toThrow('no longer exists')
  })

  it('runs when forced even though the preference is off', async () => {
    const { controller } = make({ forced: true })
    await controller.sync()
    expect(controller.state()).toMatchObject({ running: true, enabled: false, forced: true })
  })

  it('publishes state changes', async () => {
    const { controller, states } = make()
    await controller.setEnabled(true)
    await controller.addAgent('A')
    expect(states.length).toBeGreaterThanOrEqual(2)
    expect(states.at(-1)?.running).toBe(true)
  })
})
