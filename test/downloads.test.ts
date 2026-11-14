import { describe, expect, it } from 'vitest'
import { safeFilename, uniquePath } from '../src/main/downloads'
import {
  describeDownload,
  downloadPercent,
  formatBytes,
  sortDownloads
} from '../src/shared/downloads'
import type { DownloadNotice } from '../src/shared/types'

function notice(overrides: Partial<DownloadNotice>): DownloadNotice {
  return {
    id: 'dl1',
    filename: 'file.bin',
    state: 'started',
    receivedBytes: 0,
    totalBytes: 0,
    startedAt: 1,
    ...overrides
  }
}

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

describe('download progress', () => {
  it('reports a percentage only when the total is known', () => {
    expect(downloadPercent(notice({ receivedBytes: 50, totalBytes: 200 }))).toBe(25)
    expect(downloadPercent(notice({ receivedBytes: 50, totalBytes: 0 }))).toBeNull()
    expect(downloadPercent(notice({ state: 'completed' }))).toBe(100)
    expect(downloadPercent(notice({ receivedBytes: 400, totalBytes: 200 }))).toBe(100)
  })

  it('formats byte counts', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
  })

  it('describes each state', () => {
    expect(describeDownload(notice({ totalBytes: 200, receivedBytes: 50 }))).toBe('25% of 200 B')
    expect(describeDownload(notice({ receivedBytes: 512 }))).toBe('512 B received')
    expect(describeDownload(notice({ state: 'completed', totalBytes: 2048 }))).toBe('2 KB')
    expect(describeDownload(notice({ state: 'cancelled' }))).toBe('Cancelled')
    expect(describeDownload(notice({ state: 'failed' }))).toBe('Failed')
  })

  it('sorts active downloads first, then newest', () => {
    const sorted = sortDownloads([
      notice({ id: 'old', state: 'completed', startedAt: 1 }),
      notice({ id: 'new', state: 'completed', startedAt: 5 }),
      notice({ id: 'active', state: 'started', startedAt: 2 })
    ])
    expect(sorted.map((item) => item.id)).toEqual(['active', 'new', 'old'])
  })
})
