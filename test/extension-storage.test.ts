import { mkdtempSync, rmSync } from 'node:fs'
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
