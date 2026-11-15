import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TorManager, TorUnavailableError } from '../src/main/tor/manager'

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  killed: boolean
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.killed = false
  child.kill = vi.fn(() => {
    child.killed = true
    child.exitCode = 0
    child.emit('exit', 0, null)
    return true
  })
  return child
}

function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'ncc-tor-manager-'))
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manager(overrides: Partial<ConstructorParameters<typeof TorManager>[0]> = {}) {
  const dataDir = overrides.dataDir ?? tmpDataDir()
  dirs.push(dataDir)
  return new TorManager({
    mode: () => 'auto',
    socks: () => 'socks5://127.0.0.1:9050',
    binaryPath: () => null,
    dataDir,
    probe: async () => false,
    ...overrides
  })
}

describe('TorManager', () => {
  it('uses an explicit external proxy before the bundled binary', async () => {
    const proxy = 'socks5://127.0.0.1:9150'
    const spawnProcess = vi.fn()
    const tor = manager({
      envSocks: proxy,
      binaryPath: () => '/tmp/tor',
      spawnProcess: spawnProcess as never,
      probe: async (candidate) => candidate === proxy
    })

    await expect(tor.ensureReady()).resolves.toEqual({ proxy, kind: 'local' })
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(tor.status()).toMatchObject({ ready: true, proxy, kind: 'local' })
  })

  it('uses the configured local proxy in local mode', async () => {
    const proxy = 'socks5://127.0.0.1:19050'
    const tor = manager({
      mode: () => 'local',
      socks: () => proxy,
      probe: async (candidate) => candidate === proxy
    })
    await expect(tor.ensureReady()).resolves.toEqual({ proxy, kind: 'local' })
  })

  it('rejects a local proxy that is not listening', async () => {
    const tor = manager({
      mode: () => 'local',
      socks: () => 'socks5://127.0.0.1:19050',
      probe: async () => false
    })
    await expect(tor.ensureReady()).rejects.toBeInstanceOf(TorUnavailableError)
  })

  it('starts the bundled binary, strips the bootstrap log and reports readiness', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn((_binary: string, _args: string[]) => {
      setImmediate(() => child.stdout.write('Nov 15 [notice] Bootstrapped 100% (done): Done\n'))
      return child
    })
    const onProxyChange = vi.fn()
    const tor = manager({
      binaryPath: () => '/opt/tor/tor',
      spawnProcess: spawnProcess as never,
      probe: async () => true,
      onProxyChange
    })

    const runtime = await tor.ensureReady()
    expect(runtime.kind).toBe('bundled')
    expect(runtime.proxy).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/)
    expect(spawnProcess).toHaveBeenCalledOnce()
    const [, args] = spawnProcess.mock.calls[0]
    expect(args).toContain('--ClientOnly')
    expect(args).toContain('--SocksPort')
    expect(args).toContain('--__OwningControllerProcess')
    expect(args).toContain(String(process.pid))
    expect(onProxyChange).toHaveBeenLastCalledWith(runtime.proxy)

    await tor.stop()
  })

  it('falls back to a local proxy when the bundled Tor exits early', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => {
      setImmediate(() => {
        child.exitCode = 1
        child.emit('exit', 1, null)
      })
      return child
    })
    const tor = manager({
      binaryPath: () => '/opt/tor/tor',
      spawnProcess: spawnProcess as never,
      probe: async (candidate) => candidate === 'socks5://127.0.0.1:9150',
      localPorts: [9050, 9150]
    })

    await expect(tor.ensureReady()).resolves.toEqual({
      proxy: 'socks5://127.0.0.1:9150',
      kind: 'local'
    })
    expect(tor.status().error).toBeNull()
  })

  it('reports unavailable when neither bundled nor local Tor answers', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => {
      setImmediate(() => {
        child.exitCode = 1
        child.emit('exit', 1, null)
      })
      return child
    })
    const tor = manager({
      binaryPath: () => '/opt/tor/tor',
      spawnProcess: spawnProcess as never,
      probe: async () => false,
      localPorts: [19050]
    })

    await expect(tor.ensureReady()).rejects.toBeInstanceOf(TorUnavailableError)
    expect(tor.status().ready).toBe(false)
    expect(tor.status().error).toMatch(/Bundled Tor failed/i)
  })

  it('reports a bootstrap timeout and stops the child', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => child)
    const tor = manager({
      binaryPath: () => '/opt/tor/tor',
      spawnProcess: spawnProcess as never,
      probe: async () => true,
      bootstrapTimeoutMs: 30,
      localPorts: []
    })

    await expect(tor.ensureReady()).rejects.toThrow(/did not bootstrap/i)
    expect(child.kill).toHaveBeenCalled()
  })

  it('resets the proxy and stops the bundled process', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => {
      setImmediate(() => child.stdout.write('Bootstrapped 100% (done)\n'))
      return child
    })
    const onProxyChange = vi.fn()
    const tor = manager({
      binaryPath: () => '/opt/tor/tor',
      spawnProcess: spawnProcess as never,
      probe: async () => true,
      onProxyChange
    })
    await tor.ensureReady()
    await tor.reset()
    expect(onProxyChange).toHaveBeenLastCalledWith(null)
    expect(child.kill).toHaveBeenCalled()
    expect(tor.status().ready).toBe(false)
  })
})
