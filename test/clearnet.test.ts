import { describe, expect, it } from 'vitest'
import { clearnetState } from '../src/renderer/src/lib/clearnet'

describe('clearnetState', () => {
  it('marks HTTPS as secure', () => {
    expect(clearnetState('https://example.com/path')).toEqual({
      tone: 'ok',
      label: 'secure',
      host: 'example.com'
    })
  })

  it('marks HTTP as insecure', () => {
    expect(clearnetState('http://127.0.0.1:8080/')).toEqual({
      tone: 'warn',
      label: 'insecure',
      host: '127.0.0.1:8080'
    })
  })

  it('falls back to a neutral clearnet state', () => {
    expect(clearnetState('file:///tmp/page.html')).toEqual({
      tone: 'muted',
      label: 'web',
      host: ''
    })
    expect(clearnetState('not a url')).toEqual({
      tone: 'muted',
      label: 'web',
      host: ''
    })
  })
})
