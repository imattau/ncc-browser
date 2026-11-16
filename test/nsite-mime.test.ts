import { describe, expect, it } from 'vitest'
import { contentTypeFor, mimeForPath } from '../src/main/nsite/mime'

describe('mimeForPath', () => {
  it('knows the types a static site needs', () => {
    expect(mimeForPath('/index.html')).toBe('text/html; charset=utf-8')
    expect(mimeForPath('/assets/main.js')).toBe('text/javascript; charset=utf-8')
    expect(mimeForPath('/site.CSS')).toBe('text/css; charset=utf-8')
    expect(mimeForPath('/no-extension')).toBe('application/octet-stream')
  })
})

describe('contentTypeFor', () => {
  it('lets the path extension win over a blob store that says text/plain', () => {
    expect(contentTypeFor('/index.html', 'text/plain')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/assets/app.js', 'text/plain')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('/logo.png', 'binary/octet-stream')).toBe('image/png')
  })

  it('keeps the upstream type for extensionless paths', () => {
    expect(contentTypeFor('/api/feed', 'application/json')).toBe('application/json')
    expect(contentTypeFor('/route', 'text/html; charset=utf-8')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('/route', null)).toBe('application/octet-stream')
  })
})
