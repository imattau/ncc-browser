import { describe, expect, it, vi } from 'vitest'
import type { SignerRequest } from '../src/shared/types'
import type { ApprovalBroker } from '../src/main/approval'
import type { IdentityManager } from '../src/main/signer/manager'
import type { PermissionStore } from '../src/main/signer/permissions'
import { Nip07Service, type Caller } from '../src/main/signer/service'

function harness(
  options: { remember?: boolean; trusted?: boolean; defer?: boolean } = {}
) {
  const requests: Array<Omit<SignerRequest, 'id'>> = []
  const resolvers: Array<(decision: { allow: boolean; remember: boolean }) => void> = []
  const provider = {
    getPublicKey: vi.fn(async () => 'npub1test'),
    signEvent: vi.fn(async (event: { kind: number }) => ({ ...event, id: 'signed', sig: 'sig' })),
    nip04Encrypt: vi.fn(),
    nip04Decrypt: vi.fn(),
    nip44Encrypt: vi.fn(),
    nip44Decrypt: vi.fn()
  }
  const identity = {
    provider: () => provider,
    status: () => ({ configured: true, mode: 'local', npub: 'npub1test', source: 'file' })
  } as unknown as IdentityManager
  const permissions = {
    isTrusted: vi.fn(() => options.trusted === true),
    trust: vi.fn(),
    touch: vi.fn(),
    list: vi.fn(() => []),
    revoke: vi.fn(),
    clear: vi.fn()
  } as unknown as PermissionStore
  const approvals = {
    request: vi.fn((request: Omit<SignerRequest, 'id'>) => {
      requests.push(request)
      if (!options.defer) {
        return Promise.resolve({ allow: true, remember: options.remember ?? true })
      }
      return new Promise<{ allow: boolean; remember: boolean }>((resolve) =>
        resolvers.push(resolve)
      )
    })
  } as unknown as ApprovalBroker
  const service = new Nip07Service({
    identity,
    permissions,
    approvals,
    getRelays: () => [],
    autoApprove: false
  })
  return { service, provider, permissions, approvals, requests, resolvers }
}

function caller(kind: Caller['kind'] = 'normal', origin = 'ncc://npub1test/web'): Caller {
  return {
    origin,
    label: origin,
    kind,
    ephemeral: kind !== 'normal',
    torTab: kind === 'tor'
  }
}

describe('Nip07Service permissions', () => {
  it('persists an always-allow decision for a normal tab', async () => {
    const { service, provider, permissions, requests } = harness()
    await expect(service.getPublicKey(caller('normal'))).resolves.toBe('npub1test')
    expect(provider.getPublicKey).toHaveBeenCalledOnce()
    expect(permissions.trust).toHaveBeenCalledWith('ncc://npub1test/web', 'ncc://npub1test/web')
    expect(requests[0]).toMatchObject({
      ephemeral: false,
      torTab: false,
      rememberLabel: 'Always allow'
    })
  })

  it('never persists an ephemeral decision and remembers it only for that session', async () => {
    const { service, permissions, approvals, requests } = harness()
    const privateCaller = caller('private')

    await service.getPublicKey(privateCaller)
    await service.getPublicKey(privateCaller)
    expect(permissions.trust).not.toHaveBeenCalled()
    expect(approvals.request).toHaveBeenCalledOnce()
    expect(requests[0]).toMatchObject({
      ephemeral: true,
      torTab: false,
      rememberLabel: 'Remember for this session'
    })

    service.clearEphemeral('private')
    await service.getPublicKey(privateCaller)
    expect(approvals.request).toHaveBeenCalledTimes(2)
  })

  it('marks Tor-tab requests for the NIP-46 warning', async () => {
    const { service, requests } = harness()
    await service.getPublicKey(caller('tor'))
    expect(requests[0]).toMatchObject({ ephemeral: true, torTab: true })
  })

  it('does not share ephemeral permissions between private and Tor sessions', async () => {
    const { service, approvals } = harness()
    await service.getPublicKey(caller('private'))
    await service.getPublicKey(caller('tor'))
    expect(approvals.request).toHaveBeenCalledTimes(2)
  })
})

describe('Nip07Service approval ergonomics', () => {
  const NOW = Math.floor(Date.now() / 1000)
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  const RELAY_AUTH = {
    kind: 22242,
    created_at: NOW,
    tags: [
      ['relay', 'wss://relay.example'],
      ['challenge', 'abc']
    ],
    content: ''
  }

  const NOTE = {
    kind: 1,
    created_at: NOW,
    tags: [],
    content: 'hello'
  }

  it('asks once per session for the public key', async () => {
    const { service, approvals } = harness({ remember: false })
    const site = caller()

    await expect(service.getPublicKey(site)).resolves.toBe('npub1test')
    await expect(service.getPublicKey(site)).resolves.toBe('npub1test')
    expect(approvals.request).toHaveBeenCalledOnce()
  })

  it('asks once per session for relay authentication, not for other events', async () => {
    const { service, approvals, requests } = harness({ remember: false })
    const site = caller()

    await service.signEvent(site, RELAY_AUTH)
    await service.signEvent(site, RELAY_AUTH)
    expect(approvals.request).toHaveBeenCalledOnce()
    expect(requests[0]).toMatchObject({
      action: 'log in to a relay',
      note: 'Relay: wss://relay.example'
    })

    await service.signEvent(site, NOTE)
    await service.signEvent(site, NOTE)
    expect(approvals.request).toHaveBeenCalledTimes(3)
  })

  it('names common event kinds in the prompt', async () => {
    const { service, requests } = harness({ remember: false })
    await service.signEvent(caller(), NOTE)
    await service.signEvent(caller(), { ...NOTE, kind: 9999 })
    expect(requests[0].action).toBe('publish a note')
    expect(requests[1].action).toBe('sign a kind 9999 event')
  })

  it('collapses identical concurrent requests into one prompt', async () => {
    const { service, approvals, resolvers } = harness({ defer: true })
    const site = caller()

    const first = service.getPublicKey(site)
    const second = service.getPublicKey(site)
    await flush()
    expect(approvals.request).toHaveBeenCalledOnce()

    resolvers[0]({ allow: true, remember: false })
    await expect(first).resolves.toBe('npub1test')
    await expect(second).resolves.toBe('npub1test')
  })

  it('queues prompts per origin instead of globally', async () => {
    const { service, approvals } = harness({ defer: true })

    void service.getPublicKey(caller('normal', 'ncc://npub1aaa/web'))
    void service.getPublicKey(caller('normal', 'ncc://npub1bbb/web'))
    await flush()

    expect(approvals.request).toHaveBeenCalledTimes(2)
  })

  it('stops re-asking for the same request after a refusal', async () => {
    const { service, approvals, resolvers } = harness({ defer: true })
    const site = caller()

    const first = service.getPublicKey(site)
    await flush()
    resolvers[0]({ allow: false, remember: false })
    await expect(first).rejects.toThrow('denied')

    await expect(service.getPublicKey(site)).rejects.toThrow('denied')
    expect(approvals.request).toHaveBeenCalledOnce()
  })

  it('lets a trusted origin through without a prompt', async () => {
    const { service, approvals } = harness({ trusted: true })
    await expect(service.getPublicKey(caller())).resolves.toBe('npub1test')
    expect(approvals.request).not.toHaveBeenCalled()
  })
})
