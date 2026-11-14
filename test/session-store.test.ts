import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/main/session-store'

const directories: string[] = []

function store(): { store: SessionStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'ncc-session-'))
  directories.push(directory)
  const path = join(directory, 'session.json')
  return { store: new SessionStore(path), path }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SessionStore', () => {
  it('round-trips tabs, active index and geometry', () => {
    const { store: sessions, path } = store()
    sessions.save({
      tabs: [{ url: 'ncc://npub1abc/web' }, { url: '' }],
      activeIndex: 1,
      window: { width: 1100, height: 700, x: 20, y: 30, maximized: false }
    })

    const loaded = new SessionStore(path).load()
    expect(loaded?.tabs).toEqual([{ url: 'ncc://npub1abc/web' }, { url: '' }])
    expect(loaded?.activeIndex).toBe(1)
    expect(loaded?.window).toMatchObject({ width: 1100, height: 700, x: 20, y: 30 })
  })

  it('drops non-web urls and clamps the active index', () => {
    const { store: sessions } = store()
    sessions.save({
      tabs: [{ url: 'javascript:alert(1)' }, { url: 'https://example.com' }],
      activeIndex: 99,
      window: { width: 1280, height: 860, maximized: true }
    })

    const loaded = sessions.load()
    expect(loaded?.tabs).toEqual([{ url: '' }, { url: 'https://example.com' }])
    expect(loaded?.activeIndex).toBe(1)
  })

  it('rejects an empty or malformed session', () => {
    const { store: sessions, path } = store()
    expect(sessions.load()).toBeNull()

    writeFileSync(path, JSON.stringify({ version: 1, tabs: [] }), 'utf8')
    expect(sessions.load()).toBeNull()

    writeFileSync(path, '{broken', 'utf8')
    expect(sessions.load()).toBeNull()
  })

  it('clamps absurd geometry', () => {
    const { store: sessions, path } = store()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        tabs: [{ url: 'https://example.com' }],
        activeIndex: 0,
        window: { width: 1, height: 999_999 }
      }),
      'utf8'
    )
    expect(sessions.load()?.window).toMatchObject({ width: 760, height: 10_000 })
  })
})
