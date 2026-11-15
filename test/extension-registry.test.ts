import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('ExtensionRegistry', () => {
  it('installs a folder, persists state and loads its icon', () => {
    const base = root()
    const source = join(base, 'hello')
    cpSync(fixture, source, { recursive: true })
    const registry = new ExtensionRegistry(join(base, 'data'))
    const result = registry.installFolder(source, { source: 'folder' })
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
    const id = registry.installFolder(source).extension!.id
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
    const result = registry.installFolder(source)
    expect(result.ok).toBe(false)

    const good = join(base, 'good')
    cpSync(fixture, good, { recursive: true })
    const installed = registry.installFolder(good).extension!
    registry.remove(installed.id)
    expect(registry.state().extensions).toHaveLength(0)
    expect(() => readFileSync(join(installed.installPath, 'manifest.json'))).toThrow()
  })

  it('preserves extension storage across a reinstall', () => {
    const base = root()
    const source = join(base, 'hello')
    cpSync(fixture, source, { recursive: true })
    const registry = new ExtensionRegistry(join(base, 'data'))
    const first = registry.installFolder(source).extension!
    writeFileSync(join(first.installPath, 'storage-local.json'), '{"count":7}\n')
    const second = registry.installFolder(source).extension!
    expect(second.id).toBe(first.id)
    expect(readFileSync(join(second.installPath, 'storage-local.json'), 'utf8')).toContain('7')
  })

  it('does not allow a package path to escape through resolveFile', () => {
    const base = root()
    const source = join(base, 'hello')
    cpSync(fixture, source, { recursive: true })
    const registry = new ExtensionRegistry(join(base, 'data'))
    const id = registry.installFolder(source).extension!.id
    expect(registry.resolveFile(id, '../manifest.json')).toBeNull()
    expect(registry.resolveFile(id, '/etc/passwd')).toBeNull()
    expect(registry.resolveFile(id, 'manifest.json')).toContain(id)
  })
})
