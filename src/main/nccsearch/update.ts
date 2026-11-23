import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { NccSearchUpdateManifest } from '@shared/nccsearch-update'
import { nccSearchManifestPayload } from '@shared/nccsearch-update'

const REPO = 'imattau/ncc-browser'
const PUBLIC_KEY = 'zGBJNgZh40T4WxQt62ZBV5qbnNNRNKRei3/cUnYKkyQ='
const PUBLIC_KEY_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const MAX_FILE_SIZE = 20 * 1024 * 1024

export interface NccSearchUpdateStatus { currentVersion: string; availableVersion: string | null }

export class NccSearchUpdater {
  private readonly updatesDir: string
  private readonly activeFile: string
  private readonly bundledVersionFile: string
  private checking: Promise<string | null> | null = null

  constructor(private readonly dataDir: string, private readonly bundledDir: string) {
    this.updatesDir = join(dataDir, 'nccsearch-updates')
    this.activeFile = join(this.updatesDir, 'active-version')
    this.bundledVersionFile = join(bundledDir, 'version.txt')
    this.activatePending()
  }

  private activatePending(): void {
    try {
      const pending = readFileSync(join(this.updatesDir, 'pending-version'), 'utf8').trim()
      if (/^[a-f0-9]{7,40}$/.test(pending) && existsSync(join(this.updatesDir, pending, 'index.html'))) {
        const pointer = `${this.activeFile}.tmp`
        writeFileSync(pointer, `${pending}\n`)
        renameSync(pointer, this.activeFile)
      }
      unlinkSync(join(this.updatesDir, 'pending-version'))
    } catch { /* no pending update */ }
  }

  activeDirectory(): string {
    try {
      const version = readFileSync(this.activeFile, 'utf8').trim()
      if (/^[a-f0-9]{7,40}$/.test(version) && existsSync(join(this.updatesDir, version, 'index.html'))) return join(this.updatesDir, version)
    } catch { /* use the packaged version */ }
    return this.bundledDir
  }

  currentVersion(): string {
    try {
      const active = readFileSync(this.activeFile, 'utf8').trim()
      if (/^[a-f0-9]{7,40}$/.test(active) && existsSync(join(this.updatesDir, active, 'index.html'))) return active
    } catch { /* use bundled version */ }
    try { return readFileSync(this.bundledVersionFile, 'utf8').trim() } catch { return 'bundled' }
  }

  check(): Promise<string | null> {
    if (this.checking) return this.checking
    this.checking = this.checkInternal().finally(() => { this.checking = null })
    return this.checking
  }

  async install(version: string): Promise<void> {
    const manifest = await this.latestManifest()
    if (manifest.version !== version) throw new Error('The update changed. Check for updates again.')
    const staging = join(this.updatesDir, `${version}.staging`)
    const target = join(this.updatesDir, version)
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      for (const file of manifest.files) {
        const url = this.fileUrl(manifest, file.asset)
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Could not download nccsearch file (${response.status})`)
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > MAX_FILE_SIZE || sha256(bytes) !== file.sha256) throw new Error('nccsearch file failed integrity verification')
        const output = resolve(staging, file.path)
        const relativePath = relative(staging, output)
        if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || resolve(output) !== output) throw new Error('Invalid nccsearch file path')
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, bytes, { flag: 'wx' })
      }
      if (!existsSync(join(staging, 'index.html'))) throw new Error('nccsearch update is missing its entry page')
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
      const pendingFile = join(this.updatesDir, 'pending-version')
      const pointer = `${pendingFile}.tmp`
      await writeFile(pointer, `${version}\n`)
      await rename(pointer, pendingFile)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  private async checkInternal(): Promise<string | null> {
    const manifest = await this.latestManifest()
    return manifest.version === this.currentVersion() ? null : manifest.version
  }

  private async latestManifest(): Promise<NccSearchUpdateManifest> {
    const releaseResponse = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ncc-browser-nccsearch-updater' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!releaseResponse.ok) throw new Error('No nccsearch update release is available')
    const release = await releaseResponse.json() as { tag_name?: string }
    if (!release.tag_name || !/^v[\d.]+(?:-[\w.]+)?$/.test(release.tag_name)) throw new Error('Invalid release tag')
    const url = `https://github.com/${REPO}/releases/download/${release.tag_name}/nccsearch-manifest.json`
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error('nccsearch manifest is unavailable')
    const manifest = await response.json() as NccSearchUpdateManifest
    this.validateManifest(manifest, release.tag_name)
    return manifest
  }

  private validateManifest(manifest: NccSearchUpdateManifest, tag: string): void {
    if (!manifest || !/^[a-f0-9]{7,40}$/.test(manifest.version) || manifest.releaseTag !== tag || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 500) throw new Error('Invalid nccsearch manifest')
    for (const file of manifest.files) {
      if (!file || !/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..') || !/^nccsearch-file-[a-zA-Z0-9._-]+$/.test(file.asset) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid nccsearch manifest file')
    }
    const key = createPublicKey({ key: Buffer.concat([PUBLIC_KEY_DER_PREFIX, Buffer.from(PUBLIC_KEY, 'base64')]), format: 'der', type: 'spki' })
    const payload = nccSearchManifestPayload({ version: manifest.version, releaseTag: manifest.releaseTag, files: manifest.files })
    if (!verify(null, Buffer.from(payload), key, Buffer.from(manifest.signature, 'base64'))) throw new Error('nccsearch manifest signature is invalid')
  }

  private fileUrl(manifest: NccSearchUpdateManifest, asset: string): string {
    return `https://github.com/${REPO}/releases/download/${manifest.releaseTag}/${encodeURIComponent(asset)}`
  }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
