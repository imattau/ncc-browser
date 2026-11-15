import { describe, expect, it, vi } from 'vitest'
import type { SignerRequest } from '../src/shared/types'
import type { ApprovalBroker } from '../src/main/approval'
import type { IdentityManager } from '../src/main/signer/manager'
import type { PermissionStore } from '../src/main/signer/permissions'
import { Nip07Service, type Caller } from '../src/main/signer/service'

function harness() {
  const requests: Array<Omit<SignerRequest, 'id'>> = []
  const provider = {
    getPublicKey: vi.fn(async () => 'npub1test'),
    signEvent: vi.fn(),
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
    isTrusted: vi.fn(() => false),
    trust: vi.fn(),
    touch: vi.fn(),
    list: vi.fn(() => []),
    revoke: vi.fn(),
    clear: vi.fn()
  } as unknown as PermissionStore
  const approvals = {
    request: vi.fn(async (request: Omit<SignerRequest, 'id'>) => {
      requests.push(request)
      return { allow: true, remember: true }
    })
  } as unknown as ApprovalBroker
  const service = new Nip07Service({
    identity,
    permissions,
    approvals,
    getRelays: () => [],
    autoApprove: false
  })
  return { service, provider, permissions, approvals, requests }
}

function caller(kind: Caller['kind'] = 'normal'): Caller {
  return {
    origin: 'ncc://npub1test/web',
    label: 'ncc://npub1test/web',
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
