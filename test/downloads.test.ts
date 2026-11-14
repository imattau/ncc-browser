import { describe, expect, it } from 'vitest'
import { safeFilename, uniquePath } from '../src/main/downloads'

describe('safeFilename', () => {
  it('strips path traversal', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd')
    expect(safeFilename('..\\..\\windows\\system32\\evil.exe')).toBe('evil.exe')
  })

  it('replaces filesystem-hostile characters', () => {
    expect(safeFilename('report:2026?.pdf')).toBe('report_2026_.pdf')
  })

  it('falls back for empty or dot-only names', () => {
    expect(safeFilename('')).toBe('download')
    expect(safeFilename('...')).toBe('download')
  })

  it('bounds the length', () => {
    expect(safeFilename('a'.repeat(400)).length).toBe(180)
  })
})

describe('uniquePath', () => {
  it('uses the name directly when free', () => {
    expect(uniquePath('/tmp/downloads', 'file.txt', () => false)).toBe('/tmp/downloads/file.txt')
  })

  it('adds a numeric suffix before the extension', () => {
    const taken = new Set(['/tmp/downloads/file.txt', '/tmp/downloads/file (1).txt'])
    expect(uniquePath('/tmp/downloads', 'file.txt', (path) => taken.has(path))).toBe(
      '/tmp/downloads/file (2).txt'
    )
  })

  it('handles names without an extension', () => {
    const taken = new Set(['/tmp/downloads/README'])
    expect(uniquePath('/tmp/downloads', 'README', (path) => taken.has(path))).toBe(
      '/tmp/downloads/README (1)'
    )
  })
})
