/**
 * Installed-extension registry. Packages live under `userData/extensions/<id>`, so
 * uninstall is a directory removal and no extension code is ever loaded from an
 * arbitrary user path after install.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  MAX_CSS_BYTES,
  MAX_EXTENSION_BYTES,
  MAX_EXTENSION_FILES,
  MAX_ICON_BYTES,
  MAX_SCRIPT_BYTES,
  normalizeExtensionManifest,
  permissionWarnings,
  reviewAccess,
  safeRelativePath,
  type ExtensionActionInfo,
  type ExtensionInfo,
  type ExtensionInstallResult,
  type ExtensionPrepareResult,
  type ExtensionManifest,
  type ExtensionSource,
  type ExtensionsState
} from '@shared/extensions'
import { extractZip } from './zip'

interface StoredExtension {
  id: string
  installPath: string
  sourcePath: string
  source: ExtensionSource
  enabled: boolean
  privateTabs: boolean
  installedAt: number
  updatedAt: number
  manifest: ExtensionManifest
  warnings: string[]
}

interface RegistryFile {
  version: 1
  developerMode: boolean
  extensions: Record<string, StoredExtension>
}

interface PreparedInstall {
  staging: string
  id: string
  source: ExtensionSource
  sourcePath: string
  manifest: ExtensionManifest
  warnings: string[]
  /** The installed manifest the review compared against, to detect a stale approval. */
  reviewed: ExtensionManifest | null
}

interface InstallOptions {
  source?: ExtensionSource
  sourcePath?: string
}

const STAGING_PREFIX = '.staging-'
const UNPACK_PREFIX = '.unpack-'
const STORAGE_FILES = ['storage-local.json', 'storage-sync.json']
const SKIP_NAMES = new Set(['.git', 'node_modules', '__MACOSX', '.DS_Store'])

export class ExtensionRegistry {
  private data: RegistryFile
  private readonly iconCache = new Map<string, string | null>()
  private readonly fileCache = new Map<string, { key: string; value: string }>()
  private readonly prepared = new Map<string, PreparedInstall>()

  constructor(
    private readonly baseDir: string,
    private readonly filePath = join(baseDir, 'extensions.json')
  ) {
    mkdirSync(baseDir, { recursive: true })
    this.data = this.load()
    this.repair()
    this.clearLeftovers()
  }

  state(): ExtensionsState {
    const extensions = Object.values(this.data.extensions)
      .map((entry) => this.toInfo(entry))
      .sort((a, b) => a.name.localeCompare(b.name))
    const actions: ExtensionActionInfo[] = []
    for (const entry of Object.values(this.data.extensions)) {
      if (!entry.enabled || !entry.manifest.action) continue
      actions.push({
        extensionId: entry.id,
        title: entry.manifest.action.default_title || entry.manifest.name,
        iconDataUrl: this.icon(entry),
        hasPopup: Boolean(entry.manifest.action.default_popup)
      })
    }
    return {
      developerMode: this.data.developerMode,
      extensions,
      actions: actions.sort((a, b) => a.title.localeCompare(b.title))
    }
  }

  list(): StoredExtension[] {
    return Object.values(this.data.extensions)
  }

  get(id: string): StoredExtension | null {
    return this.data.extensions[id] ?? null
  }

  /**
   * Copy a package into staging and describe it. Nothing is installed until
   * `commit`. Only one review is open at a time.
   */
  prepareFolder(sourcePath: string, options: InstallOptions = {}): ExtensionPrepareResult {
    let source: string
    try {
      source = realpathSync(resolve(sourcePath))
      if (!statSync(source).isDirectory()) throw new Error('Choose an extension folder')
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    return this.stage(source, {
      source: options.source ?? 'folder',
      sourcePath: options.sourcePath ?? source
    })
  }

  prepareZip(zipPath: string): ExtensionPrepareResult {
    let source: string
    try {
      source = realpathSync(resolve(zipPath))
      if (!statSync(source).isFile()) throw new Error('Choose a .zip or .nccx package')
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }

    const temp = join(this.baseDir, `${UNPACK_PREFIX}${randomBytes(8).toString('hex')}`)
    try {
      mkdirSync(temp, { recursive: true })
      extractZip(readFileSync(source), temp)
      return this.stage(temp, { source: 'zip', sourcePath: source })
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }

  /** The installed extension a pending approval would replace, if any. */
  replacementFor(token: string): string | null {
    const pending = this.prepared.get(token)
    return pending && this.data.extensions[pending.id] ? pending.id : null
  }

  /** Install exactly what was reviewed. */
  commit(token: string, choices: { privateTabs?: boolean } = {}): ExtensionInstallResult {
    const pending = this.prepared.get(token)
    if (!pending) return { ok: false, error: 'That review has expired. Choose the package again.' }
    this.prepared.delete(token)
    const { id, staging, manifest } = pending
    const previous = this.data.extensions[id]
    if ((previous?.manifest ?? null) !== pending.reviewed) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, error: 'The installed extension changed. Choose the package again.' }
    }

    const installPath = join(this.baseDir, id)
    const now = Date.now()
    try {
      // Copied now, not at review time, so nothing written meanwhile is lost.
      preserveStorage(installPath, staging)
      rmSync(installPath, { recursive: true, force: true })
      renameSync(staging, installPath)
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, error: messageOf(error) }
    }

    const record: StoredExtension = {
      id,
      installPath,
      sourcePath: pending.sourcePath,
      source: pending.source,
      enabled: previous?.enabled ?? true,
      privateTabs: choices.privateTabs ?? previous?.privateTabs ?? true,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      manifest,
      warnings: pending.warnings
    }
    this.data.extensions[id] = record
    this.iconCache.delete(id)
    this.fileCache.clear()
    this.persist()
    return { ok: true, extension: this.toInfo(record) }
  }

  discard(token: string): void {
    const pending = this.prepared.get(token)
    if (!pending) return
    this.prepared.delete(token)
    rmSync(pending.staging, { recursive: true, force: true })
  }

  private stage(
    from: string,
    options: { source: ExtensionSource; sourcePath: string }
  ): ExtensionPrepareResult {
    for (const token of [...this.prepared.keys()]) this.discard(token)

    const token = randomBytes(16).toString('hex')
    const staging = join(this.baseDir, `${STAGING_PREFIX}${token}`)
    try {
      mkdirSync(staging, { recursive: true })
      copyTree(from, staging)
      // A package must not seed its own storage.
      for (const name of STORAGE_FILES) rmSync(join(staging, name), { recursive: true, force: true })
      const normalized = normalizeExtensionManifest(
        JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8'))
      )
      const manifest = normalized.manifest
      validatePackageFiles(staging, manifest)

      const existing = Object.values(this.data.extensions).find(
        (entry) =>
          entry.sourcePath === options.sourcePath &&
          (options.source !== 'zip' || entry.source === 'zip')
      )
      const id = existing?.id ?? randomBytes(16).toString('hex')
      this.prepared.set(token, {
        staging,
        id,
        source: options.source,
        sourcePath: options.sourcePath,
        manifest,
        warnings: [...normalized.warnings, ...permissionWarnings(manifest)],
        reviewed: existing?.manifest ?? null
      })
      return {
        ok: true,
        review: {
          token,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          author: manifest.author ?? '',
          source: options.source,
          sourcePath: options.sourcePath,
          replaces: existing
            ? { name: existing.manifest.name, version: existing.manifest.version }
            : null,
          ...reviewAccess(manifest, existing?.manifest ?? null),
          notices: normalized.warnings,
          privateTabs: existing?.privateTabs ?? true
        }
      }
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, error: messageOf(error) }
    }
  }

  private clearLeftovers(): void {
    for (const name of readdirSync(this.baseDir)) {
      if (name.startsWith(STAGING_PREFIX) || name.startsWith(UNPACK_PREFIX)) {
        rmSync(join(this.baseDir, name), { recursive: true, force: true })
      }
    }
  }

  remove(id: string): void {
    const record = this.data.extensions[id]
    if (!record) return
    delete this.data.extensions[id]
    this.iconCache.delete(id)
    this.fileCache.clear()
    rmSync(record.installPath, { recursive: true, force: true })
    this.persist()
  }

  setEnabled(id: string, enabled: boolean): void {
    const record = this.data.extensions[id]
    if (!record) return
    record.enabled = enabled
    record.updatedAt = Date.now()
    this.persist()
  }

  setPrivateTabs(id: string, privateTabs: boolean): void {
    const record = this.data.extensions[id]
    if (!record) return
    record.privateTabs = privateTabs
    record.updatedAt = Date.now()
    this.persist()
  }

  setDeveloperMode(value: boolean): void {
    this.data.developerMode = value
    this.persist()
  }

  get developerMode(): boolean {
    return this.data.developerMode
  }

  reload(id: string): ExtensionInstallResult {
    const record = this.data.extensions[id]
    if (!record) return { ok: false, error: 'That extension is not installed' }
    try {
      const normalized = normalizeExtensionManifest(
        JSON.parse(readFileSync(join(record.installPath, 'manifest.json'), 'utf8'))
      )
      validatePackageFiles(record.installPath, normalized.manifest)
      record.manifest = normalized.manifest
      record.warnings = [...normalized.warnings, ...permissionWarnings(normalized.manifest)]
      record.updatedAt = Date.now()
      this.iconCache.delete(id)
      this.fileCache.clear()
      this.persist()
      return { ok: true, extension: this.toInfo(record) }
    } catch (error) {
      const message = messageOf(error)
      record.warnings = [...record.warnings, message]
      this.persist()
      return { ok: false, error: message }
    }
  }

  /** Absolute path for a package file, or null if it would escape the package. */
  resolveFile(id: string, relativePath: string): string | null {
    const record = this.data.extensions[id]
    if (!record) return null
    let path: string
    try {
      path = resolve(record.installPath, safeRelativePath(relativePath, 'path'))
    } catch {
      return null
    }
    const root = `${record.installPath}${sep}`
    if (path !== record.installPath && !path.startsWith(root)) return null
    return path
  }

  readScript(id: string, relativePath: string): string | null {
    const record = this.data.extensions[id]
    const path = this.resolveFile(id, relativePath)
    if (!record || !path) return null
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null
      const key = `${stat.size}:${stat.mtimeMs}`
      const cached = this.fileCache.get(path)
      if (cached?.key === key) return cached.value
      const value = readFileSync(path, 'utf8')
      this.fileCache.set(path, { key, value })
      return value
    } catch {
      return null
    }
  }

  readCss(id: string, relativePath: string): string {
    const path = this.resolveFile(id, relativePath)
    if (!path) return ''
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > MAX_CSS_BYTES) return ''
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }

  readResource(id: string, relativePath: string): Buffer | null {
    const path = this.resolveFile(id, relativePath)
    if (!path) return null
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return null
      return readFileSync(path)
    } catch {
      return null
    }
  }

  info(id: string): ExtensionInfo | null {
    const record = this.data.extensions[id]
    return record ? this.toInfo(record) : null
  }

  /** Development helper: `NCC_EXTENSION_DIR` installs a fixture on every launch. */
  autoInstallFromEnv(path: string | undefined): void {
    if (!path?.trim()) return
    // The developer named this folder on the command line, so there is no review.
    const staged = this.prepareFolder(path.trim(), { source: 'test' })
    const result: ExtensionInstallResult = staged.ok ? this.commit(staged.review.token) : staged
    if (result.ok) this.setEnabled(result.extension!.id, true)
    else {
      console.warn('[extensions] could not install NCC_EXTENSION_DIR:', result.error)
    }
  }

  private toInfo(record: StoredExtension): ExtensionInfo {
    return {
      id: record.id,
      name: record.manifest.name,
      version: record.manifest.version,
      description: record.manifest.description,
      author: record.manifest.author ?? '',
      source: record.source,
      sourcePath: record.sourcePath,
      installPath: record.installPath,
      enabled: record.enabled,
      privateTabs: record.privateTabs,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
      permissions: record.manifest.permissions,
      hostPermissions: record.manifest.host_permissions,
      warnings: record.warnings,
      error: null,
      iconDataUrl: this.icon(record),
      hasOptions: Boolean(record.manifest.options_page),
      hasBackground: Boolean(record.manifest.background),
      hasPopup: Boolean(record.manifest.action?.default_popup),
      contentScriptCount: record.manifest.content_scripts.length
    }
  }

  private icon(record: StoredExtension): string | null {
    const cached = this.iconCache.get(record.id)
    if (cached !== undefined) return cached
    const path =
      record.manifest.icons['128'] ??
      record.manifest.icons['48'] ??
      record.manifest.icons['32'] ??
      Object.values(record.manifest.icons)[0] ??
      record.manifest.action?.default_icon ??
      null
    if (!path) {
      this.iconCache.set(record.id, null)
      return null
    }
    const absolute = this.resolveFile(record.id, path)
    if (!absolute) {
      this.iconCache.set(record.id, null)
      return null
    }
    try {
      const stat = statSync(absolute)
      if (!stat.isFile() || stat.size > MAX_ICON_BYTES) {
        this.iconCache.set(record.id, null)
        return null
      }
      const type = iconMime(absolute)
      if (!type) {
        this.iconCache.set(record.id, null)
        return null
      }
      const value = `data:${type};base64,${readFileSync(absolute).toString('base64')}`
      this.iconCache.set(record.id, value)
      return value
    } catch {
      this.iconCache.set(record.id, null)
      return null
    }
  }

  private load(): RegistryFile {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<RegistryFile>
        if (parsed?.extensions && typeof parsed.extensions === 'object') {
          return {
            version: 1,
            developerMode: parsed.developerMode === true,
            extensions: parsed.extensions as Record<string, StoredExtension>
          }
        }
      }
    } catch (error) {
      console.warn('[extensions] ignoring a corrupt registry:', error)
    }
    return { version: 1, developerMode: false, extensions: {} }
  }

  /** Drop records whose directory vanished and mark packages whose manifest broke. */
  private repair(): void {
    let changed = false
    for (const [id, record] of Object.entries(this.data.extensions)) {
      if (!existsSync(record.installPath)) {
        delete this.data.extensions[id]
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(tmp, this.filePath)
  }
}

function validatePackageFiles(root: string, manifest: ExtensionManifest): void {
  const required: Array<{ path: string; max: number }> = []
  if (manifest.background) {
    required.push({ path: manifest.background.service_worker, max: MAX_SCRIPT_BYTES })
  }
  if (manifest.action?.default_popup) {
    required.push({ path: manifest.action.default_popup, max: MAX_SCRIPT_BYTES })
  }
  if (manifest.action?.default_icon) {
    required.push({ path: manifest.action.default_icon, max: MAX_ICON_BYTES })
  }
  if (manifest.options_page) {
    required.push({ path: manifest.options_page, max: MAX_SCRIPT_BYTES })
  }
  for (const path of Object.values(manifest.icons)) {
    required.push({ path, max: MAX_ICON_BYTES })
  }
  for (const script of manifest.content_scripts) {
    for (const path of script.js) required.push({ path, max: MAX_SCRIPT_BYTES })
    for (const path of script.css) required.push({ path, max: MAX_CSS_BYTES })
  }
  for (const item of required) {
    const target = resolve(root, item.path)
    const prefix = `${resolve(root)}${sep}`
    if (!target.startsWith(prefix)) throw new Error(`Package path escapes the folder: ${item.path}`)
    let stat
    try {
      stat = statSync(target)
    } catch {
      throw new Error(`Package file is missing: ${item.path}`)
    }
    if (!stat.isFile()) throw new Error(`Package path is not a file: ${item.path}`)
    if (stat.size > item.max) throw new Error(`Package file is too large: ${item.path}`)
  }
}

function preserveStorage(from: string, to: string): void {
  if (!existsSync(from)) return
  for (const name of STORAGE_FILES) {
    const source = join(from, name)
    if (existsSync(source)) copyFileSync(source, join(to, name))
  }
}

function copyTree(source: string, destination: string): void {
  let files = 0
  let bytes = 0
  const root = realpathSync(source)

  const walk = (from: string, to: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (SKIP_NAMES.has(entry.name)) continue
      const sourcePath = join(from, entry.name)
      const targetPath = join(to, entry.name)
      if (entry.isDirectory()) {
        mkdirSync(targetPath, { recursive: true })
        walk(sourcePath, targetPath)
        continue
      }
      if (entry.isSymbolicLink()) {
        // Never follow a link outside the package.
        const real = realpathSync(sourcePath)
        if (real !== root && !real.startsWith(`${root}${sep}`)) continue
        const stat = statSync(real)
        if (!stat.isFile()) continue
        addFile(real, targetPath, stat.size)
        continue
      }
      if (!entry.isFile()) continue
      const stat = lstatSync(sourcePath)
      addFile(sourcePath, targetPath, stat.size)
    }
  }

  const addFile = (from: string, to: string, size: number): void => {
    files += 1
    bytes += size
    if (files > MAX_EXTENSION_FILES) throw new Error('The extension has too many files')
    if (bytes > MAX_EXTENSION_BYTES) throw new Error('The extension is too large')
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }

  walk(root, destination)
}

function iconMime(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.svg':
      return 'image/svg+xml'
    case '.gif':
      return 'image/gif'
    default:
      return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Used by tests and the installer UI. */
export function packageRelativePath(root: string, path: string): string {
  return relative(root, path)
}
