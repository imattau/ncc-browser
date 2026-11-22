import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AddOnionOptions, TorControlLike } from '../src/main/tor/control'
import {
  OnionManager,
  OnionUnavailableError,
  onionUrl,
  type OnionVerifier
} from '../src/main/tor/onion'

class FakeControl implements TorControlLike {
  added: AddOnionOptions[] = []
  deleted: string[] = []
  connected = false
  failAdd: Error | null = null
  nextId = 'abcdefghijklmnop'

  async connect(): Promise<void> {
    this.connected = true
  }

  async addOnion(options: AddOnionOptions): Promise<{ serviceId: string; privateKey: string }> {
    this.added.push(options)
    if (this.failAdd) throw this.failAdd
    return { serviceId: this.nextId, privateKey: options.privateKey ?? 'ED25519-V3:new' }
  }

  async delOnion(serviceId: string): Promise<void> {
    this.deleted.push(serviceId)
  }

  close(): void {
    this.connected = false
  }
}

function setup(options: { verify?: OnionVerifier; control?: FakeControl } = {}): {
  manager: OnionManager
  control: FakeControl
  file: string
  ready: { count: number }
} {
  const file = join(mkdtempSync(join(tmpdir(), 'ncc-onion-')), 'tor-services.json')
  const control = options.control ?? new FakeControl()
  const ready = { count: 0 }
  const manager = new OnionManager({
    filePath: file,
    tor: {
      ensureReady: async () => {
        ready.count += 1
      },
      controlEndpoint: () => ({ host: '127.0.0.1', port: 9051, cookiePath: '/tmp/cookie' }),
      proxy: () => 'socks5://127.0.0.1:9050'
    },
    createControl: () => control,
    verify: options.verify ?? (async () => true),
    now: () => 1_800_000_000
  })
  return { manager, control, file, ready }
}

describe('onion endpoints', () => {
  it('formats onion URLs', () => {
    expect(
      onionUrl({ onionHost: 'abcdefghijklmnop', virtualPort: 80, secure: false })
    ).toBe('http://abcdefghijklmnop.onion/')
    expect(
      onionUrl({ onionHost: 'abcdefghijklmnop', virtualPort: 443, secure: true })
    ).toBe('https://abcdefghijklmnop.onion/')
  })

  it('creates an onion, verifies it and persists the key at 0600', async () => {
    const { manager, control, file, ready } = setup()
    const status = await manager.publish('service-1', { url: 'http://127.0.0.1:8080/app' })

    expect(ready.count).toBe(1)
    expect(control.added[0]).toEqual({
      virtualPort: 80,
      targetPort: 8080,
      targetHost: '127.0.0.1'
    })
    expect(status.host).toBe('abcdefghijklmnop.onion')
    expect(status.url).toBe('http://abcdefghijklmnop.onion/')
    expect(status.verifiedAt).toBe(1_800_000_000)

    const stored = JSON.parse(readFileSync(file, 'utf8'))
    expect(stored.services).toHaveLength(1)
    expect(stored.services[0].privateKey).toBe('ED25519-V3:new')
    expect(stored.services[0].onionHost).toBe('abcdefghijklmnop')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps the key when the target changes and reuses the address', async () => {
    const { manager, control } = setup()
    await manager.publish('service-1', { url: 'http://127.0.0.1:8080' })
    const second = await manager.publish('service-1', { url: 'http://127.0.0.1:9090' })

    expect(control.deleted).toContain('abcdefghijklmnop')
    expect(control.added[1]).toMatchObject({
      targetPort: 9090,
      privateKey: 'ED25519-V3:new'
    })
    expect(second.host).toBe('abcdefghijklmnop.onion')
    expect(manager.statuses()).toHaveLength(1)
  })

  it('uses 443 and https for a TLS endpoint', async () => {
    const { manager, control } = setup()
    const status = await manager.publish('service-1', { url: 'https://127.0.0.1:8443' })
    expect(control.added[0]).toMatchObject({ virtualPort: 443, targetPort: 8443 })
    expect(status.url).toBe('https://abcdefghijklmnop.onion/')
  })

  it('records an unverified endpoint when the through-Tor check fails', async () => {
    const { manager } = setup({ verify: async () => false })
    const status = await manager.publish('service-1', { url: 'http://127.0.0.1:8080' })
    expect(status.verifiedAt).toBeUndefined()
  })

  it('removes the onion and its key', async () => {
    const { manager, control, file } = setup()
    await manager.publish('service-1', { url: 'http://127.0.0.1:8080' })
    await manager.remove('service-1')
    expect(control.deleted).toContain('abcdefghijklmnop')
    expect(manager.statuses()).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8')).services).toEqual([])
  })

  it('restores stored onions with the same key after a restart', async () => {
    const first = setup()
    await first.manager.publish('service-1', { url: 'http://127.0.0.1:8080' })

    // A fresh manager against the persisted file, as on the next app launch.
    const control = new FakeControl()
    const restored = new OnionManager({
      filePath: first.file,
      tor: {
        ensureReady: async () => undefined,
        controlEndpoint: () => ({ host: '127.0.0.1', port: 9051 }),
        proxy: () => 'socks5://127.0.0.1:9050'
      },
      createControl: () => control,
      verify: async () => true,
      now: () => 1_800_000_100
    })
    await restored.restoreAll()
    expect(control.added[0]).toMatchObject({
      targetPort: 8080,
      privateKey: 'ED25519-V3:new'
    })
    expect(restored.status('service-1')?.verifiedAt).toBe(1_800_000_100)
  })

  it('reports a missing control port clearly', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ncc-onion-')), 'tor-services.json')
    const manager = new OnionManager({
      filePath: file,
      tor: {
        ensureReady: async () => undefined,
        controlEndpoint: () => null,
        proxy: () => 'socks5://127.0.0.1:9050'
      }
    })
    await expect(
      manager.publish('service-1', { url: 'http://127.0.0.1:8080' })
    ).rejects.toBeInstanceOf(OnionUnavailableError)
  })

  it('surfaces an ADD_ONION failure', async () => {
    const control = new FakeControl()
    control.failAdd = new Error('552 no available onion')
    const { manager } = setup({ control })
    await expect(
      manager.publish('service-1', { url: 'http://127.0.0.1:8080' })
    ).rejects.toThrow(/no available onion/)
  })

  it('survives a missing key file and unsupported targets', async () => {
    const { manager } = setup()
    expect(manager.statuses()).toEqual([])
    expect(existsSync(join(tmpdir(), 'nothing-here'))).toBe(false)
    await expect(manager.publish('service-1', { url: 'ftp://127.0.0.1' })).rejects.toThrow(
      /http:\/\/ or https:\/\//
    )
  })
})
