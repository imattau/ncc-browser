import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExtensionStorage } from '../src/main/extensions/storage'

const roots: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ncc-ext-storage-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ExtensionStorage', () => {
  it('stores, reads, removes and clears local values', () => {
    const storage = new ExtensionStorage(root())
    expect(storage.set('ext', 'local', { a: 1, b: 'two' }).changes).toMatchObject({
      a: { newValue: 1 },
      b: { newValue: 'two' }
    })
    expect(storage.get('ext', 'local', null)).toEqual({ a: 1, b: 'two' })
    expect(storage.get('ext', 'local', 'a')).toEqual({ a: 1 })
    expect(storage.get('ext', 'local', ['a', 'missing'])).toEqual({ a: 1 })
    expect(storage.get('ext', 'local', { a: 0, c: 3 })).toEqual({ a: 1, c: 3 })
    expect(storage.remove('ext', 'local', 'a').changes).toMatchObject({ a: { oldValue: 1 } })
    expect(storage.get('ext', 'local', null)).toEqual({ b: 'two' })
    expect(Object.keys(storage.clear('ext', 'local').changes)).toEqual(['b'])
    expect(storage.get('ext', 'local', null)).toEqual({})
  })

  it('keeps session and private areas separate and clears private on demand', () => {
    const storage = new ExtensionStorage(root())
    storage.set('ext', 'session', { a: 1 })
    storage.set('ext', 'private', { secret: true })
    expect(storage.get('ext', 'session', null)).toEqual({ a: 1 })
    expect(storage.get('ext', 'private', null)).toEqual({ secret: true })
    storage.clearPrivate()
    expect(storage.get('ext', 'private', null)).toEqual({})
    expect(storage.get('ext', 'session', null)).toEqual({ a: 1 })
  })

  it('rejects invalid values and oversized areas', () => {
    const storage = new ExtensionStorage(root())
    expect(storage.set('ext', 'local', 'nope').error).toBeTruthy()
    expect(storage.set('ext', 'session', []).error).toBeTruthy()
    const huge = 'x'.repeat(1024 * 1024 + 1)
    expect(storage.set('ext', 'session', { huge }).error).toContain('quota')
  })
})

describe('incremental encoding', () => {
  it('keeps the file equal to the stored object across changes and reloads', () => {
    const base = mkdtempSync(join(tmpdir(), 'ncc-ext-storage-'))
    const storage = new ExtensionStorage(base)
    storage.set('a', 'local', { one: 1, 'quo"te': { text: 'é ✓' }, two: [2] })
    storage.set('a', 'local', { one: 10 })
    storage.remove('a', 'local', 'two')
    const file = readFileSync(join(base, 'a', 'storage-local.json'), 'utf8')
    expect(JSON.parse(file)).toEqual({ one: 10, 'quo"te': { text: 'é ✓' } })
    const reloaded = new ExtensionStorage(base)
    reloaded.set('a', 'local', { three: 3 })
    expect(reloaded.get('a', 'local', null)).toEqual({
      one: 10,
      'quo"te': { text: 'é ✓' },
      three: 3
    })
    rmSync(base, { recursive: true, force: true })
  })

  it('reports no change, and writes nothing, for a value already stored', () => {
    const base = mkdtempSync(join(tmpdir(), 'ncc-ext-storage-'))
    const storage = new ExtensionStorage(base)
    storage.set('a', 'local', { message: { id: 'x', tags: [] } })
    const path = join(base, 'a', 'storage-local.json')
    const before = statSync(path).ino
    expect(storage.set('a', 'local', { message: { id: 'x', tags: [] } }).changes).toEqual({})
    expect(storage.remove('a', 'local', 'missing').changes).toEqual({})
    expect(statSync(path).ino).toBe(before)
    rmSync(base, { recursive: true, force: true })
  })
})
