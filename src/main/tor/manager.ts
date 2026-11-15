/**
 * Tor lifecycle: use an explicit proxy, otherwise start the bundled Tor and fall
 * back to a local daemon. The manager is deliberately injectable so its argument
 * construction and fallback order are testable without spawning Tor.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { TorMode, TorRuntimeKind, TorStatus } from '@shared/types'
import { normalizeTorProxy, probeSocks5 } from './proxy'

export interface TorRuntime {
  proxy: string
  kind: TorRuntimeKind
}

export interface TorManagerOptions {
  mode: () => TorMode
  socks: () => string
  /** Development and e2e override. Takes precedence over the settings. */
  envSocks?: string | null
  /** Absolute path to the bundled tor executable, or null when not installed. */
  binaryPath: () => string | null
  dataDir: string
  bootstrapTimeoutMs?: number
  probe?: (proxy: string, timeoutMs?: number) => Promise<boolean>
  spawnProcess?: typeof spawn
  localPorts?: number[]
  onProxyChange?: (proxy: string | null) => void | Promise<void>
  log?: (line: string) => void
}

export class TorUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'TorUnavailableError'
  }
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 60_000
const PROBE_TTL_MS = 30_000
const MAX_LOG_LINES = 40

export class TorManager {
  private runtime: TorRuntime | null = null
  private starting: Promise<TorRuntime> | null = null
  private child: ChildProcess | null = null
  private lastError: string | null = null
  private lastProbeAt = 0
  private readonly logs: string[] = []
  private readonly probe: (proxy: string, timeoutMs?: number) => Promise<boolean>
  private readonly spawnProcess: typeof spawn

  constructor(private readonly options: TorManagerOptions) {
    this.probe = options.probe ?? probeSocks5
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  async ensureReady(): Promise<TorRuntime> {
    if (this.runtime) {
      if (Date.now() - this.lastProbeAt < PROBE_TTL_MS) return this.runtime
      if (await this.probe(this.runtime.proxy, 1200)) {
        this.lastProbeAt = Date.now()
        return this.runtime
      }
      const stopped = this.runtime
      this.runtime = null
      this.lastProbeAt = 0
      this.lastError = `Tor proxy ${stopped.proxy} stopped responding`
      if (stopped.kind === 'bundled') await this.stopChild()
    }

    if (!this.starting) {
      this.starting = this.resolve().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  status(): TorStatus {
    return {
      ready: this.runtime !== null,
      starting: this.starting !== null,
      proxy: this.runtime?.proxy ?? null,
      kind: this.runtime?.kind ?? null,
      error: this.lastError,
      mode: this.options.mode(),
      configured: this.options.socks()
    }
  }

  /** Settings action: try to establish Tor and report the result instead of throwing. */
  async test(): Promise<TorStatus> {
    try {
      await this.ensureReady()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    return this.status()
  }

  /** Apply changed settings. Any running bundled instance is restarted lazily. */
  async reset(): Promise<void> {
    this.runtime = null
    this.lastProbeAt = 0
    this.lastError = null
    await this.stopChild()
    await this.options.onProxyChange?.(null)
  }

  async stop(): Promise<void> {
    this.runtime = null
    this.lastProbeAt = 0
    await this.stopChild()
  }

  private async resolve(): Promise<TorRuntime> {
    this.lastError = null

    const env = this.options.envSocks?.trim()
    if (env) {
      return this.useExternal(env, 'local', 'NCC_TOR_SOCKS')
    }

    if (this.options.mode() === 'local') {
      return this.useExternal(this.options.socks(), 'local', 'settings')
    }

    let bundledError: unknown = null
    const binary = this.options.binaryPath()
    if (binary) {
      try {
        return await this.startBundled(binary)
      } catch (error) {
        bundledError = error
        this.addLog(
          `bundled Tor failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    } else {
      this.addLog('bundled Tor is not installed')
    }

    for (const port of this.options.localPorts ?? [9050, 9150]) {
      const proxy = `socks5://127.0.0.1:${port}`
      if (await this.probe(proxy, 800)) {
        return this.setRuntime({ proxy, kind: 'local' })
      }
    }

    const detail = this.logTail()
    const ports = (this.options.localPorts ?? [9050, 9150]).join(' or ')
    const reason =
      bundledError instanceof Error
        ? `Bundled Tor failed (${bundledError.message}) and no local SOCKS proxy answered on ${ports}.`
        : `No bundled Tor and no local SOCKS proxy answered on ${ports}.`
    this.lastError = reason
    throw new TorUnavailableError(reason, detail)
  }

  private async useExternal(
    raw: string,
    kind: TorRuntimeKind,
    source: string
  ): Promise<TorRuntime> {
    let proxy: string
    try {
      proxy = normalizeTorProxy(raw)
    } catch (error) {
      const message = `Invalid Tor proxy from ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`
      this.lastError = message
      throw new TorUnavailableError(message)
    }

    if (!(await this.probe(proxy, 1500))) {
      const message = `Nothing is listening on ${proxy}`
      this.lastError = message
      throw new TorUnavailableError(message)
    }
    return this.setRuntime({ proxy, kind })
  }

  private async startBundled(binary: string): Promise<TorRuntime> {
    await this.stopChild()
    const port = await freePort()
    const proxy = `socks5://127.0.0.1:${port}`
    const dataDir = this.options.dataDir
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dataDir, 0o700)
    } catch {
      // Best effort on platforms without POSIX permissions.
    }

    const args = [
      '--ClientOnly',
      '1',
      '--SocksPort',
      `127.0.0.1:${port}`,
      '--DataDirectory',
      dataDir,
      '--Log',
      'notice stdout',
      '--__OwningControllerProcess',
      String(process.pid)
    ]
    const dataDirs = [join(binary, '..'), join(binary, '..', '..', 'data')]
    for (const [name, flag] of [
      ['geoip', '--GeoIPFile'],
      ['geoip6', '--GeoIPv6File']
    ] as const) {
      const path = dataDirs.map((dir) => join(dir, name)).find(existsSync)
      if (path) args.push(flag, path)
    }

    const libraryPath = join(binary, '..')
    const env = { ...process.env }
    if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = appendPath(libraryPath, env.LD_LIBRARY_PATH)
    } else if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = appendPath(libraryPath, env.DYLD_LIBRARY_PATH)
    }

    this.addLog(`starting bundled Tor on ${proxy}`)
    const child = this.spawnProcess(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env
    })
    this.child = child

    try {
      await this.waitForBootstrap(child)
      if (!(await this.probe(proxy, 1500))) {
        throw new TorUnavailableError('Tor started but the SOCKS port did not answer')
      }
      this.addLog('bundled Tor is ready')
      return this.setRuntime({ proxy, kind: 'bundled' })
    } catch (error) {
      await this.stopChild()
      throw error
    }
  }

  private waitForBootstrap(child: ChildProcess): Promise<void> {
    const timeoutMs = this.options.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
        if (error) reject(error)
        else resolve()
      }

      const onData = (data: Buffer): void => {
        for (const line of data.toString('utf8').split(/\r?\n/)) {
          if (!line.trim()) continue
          this.addLog(line.trim())
          if (/Bootstrapped 100%/.test(line)) finish()
        }
      }
      const onError = (error: Error): void =>
        finish(new TorUnavailableError(`Tor could not start: ${error.message}`))
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        finish(
          new TorUnavailableError(
            `Tor exited before it was ready (${code ?? signal ?? 'unknown'})`,
            this.logTail()
          )
        )
      const timer = setTimeout(() => {
        finish(
          new TorUnavailableError(
            `Tor did not bootstrap within ${timeoutMs / 1000}s`,
            this.logTail()
          )
        )
      }, timeoutMs)

      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
  }

  private async setRuntime(runtime: TorRuntime): Promise<TorRuntime> {
    this.runtime = runtime
    this.lastProbeAt = Date.now()
    this.lastError = null
    this.addLog(`${runtime.kind} Tor ready on ${runtime.proxy}`)
    await this.options.onProxyChange?.(runtime.proxy)
    return runtime
  }

  private async stopChild(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.killed) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private addLog(line: string): void {
    this.logs.push(line)
    if (this.logs.length > MAX_LOG_LINES) this.logs.shift()
    this.options.log?.(line)
  }

  private logTail(): string | undefined {
    return this.logs.length ? this.logs.slice(-10).join('\n') : undefined
  }
}

function appendPath(value: string, existing: string | undefined): string {
  return existing ? `${value}:${existing}` : value
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a port'))))
    })
  })
}
