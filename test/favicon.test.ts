import { describe, expect, it } from 'vitest'
import { faviconDataUrl, isImageMime } from '../src/main/favicon'

describe('isImageMime', () => {
  it('accepts image content types with parameters', () => {
    expect(isImageMime('image/png')).toBe(true)
    expect(isImageMime('image/x-icon')).toBe(true)
    expect(isImageMime('image/svg+xml; charset=utf-8')).toBe(true)
  })

  it('rejects non-images and lookalikes', () => {
    expect(isImageMime('text/html')).toBe(false)
    expect(isImageMime('image')).toBe(false)
    expect(isImageMime('imagex/png')).toBe(false)
  })
})

describe('faviconDataUrl', () => {
  it('encodes small images as data urls', () => {
    const url = faviconDataUrl('image/png; charset=binary', Buffer.from([1, 2, 3]))
    expect(url).toBe('data:image/png;base64,AQID')
  })

  it('refuses non-images, empty bodies and oversized icons', () => {
    expect(faviconDataUrl('text/html', Buffer.from('<html>'))).toBeNull()
    expect(faviconDataUrl('image/png', Buffer.alloc(0))).toBeNull()
    expect(faviconDataUrl('image/png', Buffer.alloc(300 * 1024))).toBeNull()
  })
})
