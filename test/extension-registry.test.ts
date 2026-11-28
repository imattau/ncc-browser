import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionInstallResult, ExtensionInstallReview } from '../src/shared/extensions'
import { ExtensionRegistry } from '../src/main/extensions/registry'

const fixture = join(process.cwd(), 'test/fixtures/hello-extension')
const roots: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-ext-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Review a folder and approve it. */
function install(registry: ExtensionRegistry, source: string): ExtensionInstallResult {
  const prepared = registry.prepareFolder(source)
  return prepared.ok ? registry.commit(prepared.review.token) : prepared
}

function review(registry: ExtensionRegistry, source: string): ExtensionInstallReview {
  const prepared = registry.prepareFolder(source)
  if (!prepared.ok) throw new Error(prepared.error)
  return prepared.review
}

function editManifest(source: string, edit: (manifest: Record<string, any>) => void): void {
  const path = join(source, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  edit(manifest)
  writeFileSync(path, JSON.stringify(manifest))
}

function copyFixture(): { base: string; source: string; registry: ExtensionRegistry } {
  const base = root()
  const source = join(base, 'hello')
  cpSync(fixture, source, { recursive: true })
  return { base, source, registry: new ExtensionRegistry(join(base, 'data')) }
}

describe('extension install review', () => {
  it('stages the bundled White Noise package for normal permission review', () => {
    const { registry } = copyFixture()
    const packagePath = join(process.cwd(), 'extensions/white-noise-prototype.nccx')
    const pending = registry.prepareZip(packagePath, 'bundled')
    expect(pending.ok).toBe(true)
    if (!pending.ok) return

    expect(pending.review.name).toBe('White Noise Companion (Prototype)')
    expect(pending.review.source).toBe('bundled')
    expect(pending.review.privateTabs).toBe(false)
    expect(pending.review.permissions.map((permission) => permission.id)).toContain('nostr:sign')
    expect(registry.state().extensions).toHaveLength(0)
    expect(registry.commit(pending.review.token).ok).toBe(true)
  })

  it('updates an existing local companion install instead of adding a duplicate', () => {
    const { registry } = copyFixture()
    const packagePath = join(process.cwd(), 'extensions/white-noise-prototype.nccx')
    const previousPath = join(root(), 'previous-companion.nccx')
    cpSync(packagePath, previousPath)
    const previous = registry.prepareZip(previousPath)
    if (!previous.ok) throw new Error(previous.error)
    const installed = registry.commit(previous.review.token).extension!
    writeFileSync(join(installed.installPath, 'storage-local.json'), JSON.stringify({ chatState: { saved: true } }))

    const bundled = registry.prepareZip(packagePath, 'bundled')
    if (!bundled.ok) throw new Error(bundled.error)
    expect(bundled.review.replaces).toEqual({ name: 'White Noise Companion (Prototype)', version: '0.1.3' })
    expect(registry.commit(bundled.review.token).extension?.id).toBe(installed.id)
    expect(registry.state().extensions).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(installed.installPath, 'storage-local.json'), 'utf8'))).toEqual({ chatState: { saved: true } })
  })

  it('installs nothing until the review is approved', () => {
    const { source, registry } = copyFixture()
    const pending = review(registry, source)
    expect(registry.state().extensions).toHaveLength(0)
    expect(pending.replaces).toBeNull()
    expect(pending.permissions.map((item) => item.id)).toContain('nostr:sign')
    expect(pending.sites.every((item) => !item.added)).toBe(true)
    expect(registry.commit(pending.token, { privateTabs: false }).extension?.privateTabs).toBe(false)
    expect(registry.commit(pending.token).ok).toBe(false)
  })

  it('lists sites that only a content script asks for', () => {
    const { source, registry } = copyFixture()
    editManifest(source, (manifest) => {
      manifest.host_permissions = []
      manifest.content_scripts[0].matches = ['https://example.com/*']
    })
    expect(review(registry, source).sites.map((item) => item.id)).toEqual([
      'https://example.com/*'
    ])
    expect(install(registry, source).extension!.warnings).toContain(
      'Read and change data on https://example.com/*'
    )
  })

  it('marks the larger local-storage grant as added during extension updates', () => {
    const { source, registry } = copyFixture()
    expect(install(registry, source).ok).toBe(true)
    editManifest(source, (manifest) => {
      manifest.version = '2.0.0'
      manifest.permissions.push('storage:large')
    })
    const update = review(registry, source)
    expect(update.permissions.find((permission) => permission.id === 'storage:large')).toEqual({
      id: 'storage:large',
      label: 'Store up to 128 MB of local data',
      added: true
    })
  })

  it('discards the staged copy on cancel, on a newer review and after a restart', () => {
    const { base, source, registry } = copyFixture()
    const staged = (): string[] =>
      readdirSync(join(base, 'data')).filter((name) => name.startsWith('.'))

    const first = review(registry, source)
    const second = review(registry, source)
    expect(staged()).toHaveLength(1)
    expect(registry.commit(first.token).ok).toBe(false)
    registry.discard(second.token)
    expect(staged()).toHaveLength(0)

    review(registry, source)
    new ExtensionRegistry(join(base, 'data'))
    expect(staged()).toHaveLength(0)
  })

  it('installs the reviewed files even if the source changes afterwards', () => {
    const { source, registry } = copyFixture()
    const pending = review(registry, source)
    editManifest(source, (manifest) => {
      manifest.host_permissions = ['https://*/*']
    })
    writeFileSync(join(source, 'content.js'), '// swapped\n')
    const installed = registry.commit(pending.token).extension!
    expect(installed.hostPermissions).not.toContain('https://*/*')
    expect(readFileSync(join(installed.installPath, 'content.js'), 'utf8')).not.toContain('swapped')
  })

  it('marks new access on an update and keeps the old version until approval', () => {
    const { source, registry } = copyFixture()
    editManifest(source, (manifest) => {
      manifest.permissions = ['storage']
    })
    const id = install(registry, source).extension!.id
    registry.setEnabled(id, false)
    registry.setPrivateTabs(id, false)
    editManifest(source, (manifest) => {
      manifest.version = '1.1.0'
      manifest.permissions = ['storage', 'nostr:sign']
      manifest.content_scripts[0].matches.push('https://example.com/*')
    })

    const pending = review(registry, source)
    expect(pending.replaces).toEqual({ name: 'Hello NCC', version: '1.0.0' })
    expect(pending.permissions.filter((item) => item.added).map((item) => item.id)).toEqual([
      'nostr:sign'
    ])
    expect(pending.sites.filter((item) => item.added).map((item) => item.id)).toEqual([
      'https://example.com/*'
    ])
    expect(pending.privateTabs).toBe(false)
    expect(registry.get(id)?.manifest.version).toBe('1.0.0')

    const updated = registry.commit(pending.token).extension!
    expect(updated).toMatchObject({ id, version: '1.1.0', enabled: false, privateTabs: false })
  })

  it('refuses an approval if the installed extension changed meanwhile', () => {
    const { source, registry } = copyFixture()
    const id = install(registry, source).extension!.id
    const pending = review(registry, source)
    registry.remove(id)
    expect(registry.commit(pending.token).ok).toBe(false)
    expect(registry.state().extensions).toHaveLength(0)
  })

  it('does not let a package supply its own storage', () => {
    const { source, registry } = copyFixture()
    writeFileSync(join(source, 'storage-local.json'), '{"seeded":true}\n')
    const installed = install(registry, source).extension!
    expect(existsSync(join(installed.installPath, 'storage-local.json'))).toBe(false)
  })
})

describe('ExtensionRegistry', () => {
  it('installs a folder, persists state and loads its icon', () => {
    const base = root()
    const source = join(base, 'hello')
    cpSync(fixture, source, { recursive: true })
    const registry = new ExtensionRegistry(join(base, 'data'))
    const result = install(registry, source)
    expect(result.ok).toBe(true)
    const info = result.extension!
    expect(info.name).toBe('Hello NCC')
    expect(info.enabled).toBe(true)
    expect(info.privateTabs).toBe(true)
    expect(info.hasPopup).toBe(true)
    expect(info.hasBackground).toBe(true)
    expect(info.iconDataUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(info.warnings.join(' ')).toContain('Store data locally')
    expect(registry.state().actions).toHaveLength(1)

    const reloaded = new ExtensionRegistry(join(base, 'data'))
    expect(reloaded.state().extensions).toHaveLength(1)
    expect(reloaded.state().developerMode).toBe(false)
  })

  it('toggles enable and private-tab grants', () => {
    const base = root()
    const source = join(base, 'hello')
    cpSync(fixture, source, { recursive: true })
    const registry = new ExtensionRegistry(join(base, 'data'))
    const id = install(registry, source).extension!.id
    registry.setEnabled(id, false)
    registry.setPrivateTabs(id, false)
    registry.setDeveloperMode(true)
    expect(registry.get(id)?.enabled).toBe(false)
    expect(registry.get(id)?.privateTabs).toBe(false)
    expect(registry.developerMode).toBe(true)
    expect(registry.state().actions).toHaveLength(0)
  })

  it('refuses traversal manifests and removes installed files', () => {
    const base = root()
    const source = join(base, 'bad')
    cpSync(fixture, source, { recursive: true })
    const manifestPath = join(source, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.content_scripts[0].js = ['../evil.js']
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const registry = new ExtensionRegistry(join(base, 'data'))
    const result = install(registry, source)
    expect(result.ok).toBe(false)

    const good = join(base, 'good')
    cpSync(fixture, good, { recursive: true })
    const installed = install(registry, good).extension!
    registry.remove(installed.id)
    expect(registry.state().extensions).toHaveLength(0)
    expect(() => readFileSync(join(installed.installPath, 'manifest.json'))).toThrow()
  })

  it('preserves extension storage across a reinstall', () => {
    const base = root()
    const source = join(base, 'hello')
    cpSync(fixture, source, { recursive: true })
    const registry = new ExtensionRegistry(join(base, 'data'))
    const first = install(registry, source).extension!
    writeFileSync(join(first.installPath, 'storage-local.json'), '{"count":7}\n')
    const second = install(registry, source).extension!
    expect(second.id).toBe(first.id)
    expect(readFileSync(join(second.installPath, 'storage-local.json'), 'utf8')).toContain('7')
  })

  it('does not allow a package path to escape through resolveFile', () => {
    const base = root()
    const source = join(base, 'hello')
    cpSync(fixture, source, { recursive: true })
    const registry = new ExtensionRegistry(join(base, 'data'))
    const id = install(registry, source).extension!.id
    expect(registry.resolveFile(id, '../manifest.json')).toBeNull()
    expect(registry.resolveFile(id, '/etc/passwd')).toBeNull()
    expect(registry.resolveFile(id, 'manifest.json')).toContain(id)
  })
})
