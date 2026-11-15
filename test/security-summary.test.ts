import { describe, expect, it } from 'vitest'
import { securitySummary } from '../src/renderer/src/lib/security'
import type { AnchorInfo, NavState, SecurityInfo } from '../src/shared/types'

function nav(overrides: Partial<NavState> = {}): NavState {
  return {
    mode: 'blank',
    displayUrl: '',
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    security: null,
    failure: null,
    tor: { preferTor: false, onionAvailable: false, active: false },
    tabs: [],
    activeTabId: null,
    windowMaximized: false,
    ...overrides
  }
}

function anchor(status: AnchorInfo['status'], kMatch: AnchorInfo['kMatch'] = 'match'): AnchorInfo {
  return {
    status,
    record:
      status === 'unanchored'
        ? null
        : {
            eventId: 'event',
            dTag: 'web',
            endpoint: 'https://example.com',
            rawEndpoint: 'https://example.com',
            k: 'SPKI',
            expiresAt: 1_900_000_000,
            updatedAt: 1_800_000_000
          },
    fallback: false,
    kMatch,
    required: false
  }
}

function security(overrides: Partial<SecurityInfo> = {}): SecurityInfo {
  return {
    transport: 'pinned-tls',
    host: 'example.com',
    pinned: true,
    viaTor: false,
    anchor: anchor('anchored'),
    ...overrides
  }
}

describe('securitySummary', () => {
  it('is muted and not clickable on a blank tab', () => {
    expect(securitySummary(nav())).toMatchObject({
      tone: 'muted',
      label: 'blank',
      clickable: false
    })
  })

  it('marks clearnet HTTPS green and HTTP amber', () => {
    expect(
      securitySummary(nav({ mode: 'web', url: 'https://example.com/', displayUrl: 'https://example.com/' }))
    ).toMatchObject({ tone: 'ok', label: 'secure', host: 'example.com' })
    expect(
      securitySummary(nav({ mode: 'web', url: 'http://127.0.0.1:8080/', displayUrl: 'http://127.0.0.1:8080/' }))
    ).toMatchObject({ tone: 'warn', label: 'insecure', host: '127.0.0.1:8080' })
  })

  it('turns red for a clearnet load failure', () => {
    expect(
      securitySummary(
        nav({
          mode: 'web',
          url: 'https://example.com/',
          displayUrl: 'https://example.com/',
          failure: { code: 'load-failed', message: 'nope' }
        })
      )
    ).toMatchObject({ tone: 'danger', label: 'failure' })
  })

  it('maps NCC transport and anchor state', () => {
    expect(
      securitySummary(
        nav({
          mode: 'ncc',
          displayUrl: 'ncc://npub/web/',
          security: security({ transport: 'plaintext', pinned: false, host: '10.0.0.2', anchor: anchor('unanchored', 'none') })
        })
      )
    ).toMatchObject({ tone: 'warn', label: 'plaintext', anchorState: 'unanchored' })

    expect(
      securitySummary(
        nav({
          mode: 'ncc',
          displayUrl: 'ncc://npub/web/',
          security: security()
        })
      )
    ).toMatchObject({ tone: 'ok', label: 'pinned-tls', anchorState: 'anchored' })
  })

  it('describes an onion page without pretending HTTP became TLS', () => {
    const summary = securitySummary(
      nav({
        mode: 'ncc',
        displayUrl: 'ncc://npub/web/',
        tor: { preferTor: false, onionAvailable: true, active: true },
        security: security({
          transport: 'plaintext',
          pinned: false,
          host: 'abc.onion',
          viaTor: true,
          anchor: anchor('unanchored', 'none')
        })
      })
    )
    expect(summary).toMatchObject({ tone: 'warn', label: 'onion', host: 'abc.onion' })
    expect(summary.tooltip).toContain('over Tor')
  })

  it('labels a direct onion URL as Tor', () => {
    expect(
      securitySummary(
        nav({
          mode: 'web',
          displayUrl: 'http://abc.onion/',
          url: 'http://abc.onion/',
          tor: { preferTor: false, onionAvailable: false, active: true }
        })
      )
    ).toMatchObject({ tone: 'warn', label: 'onion', host: 'abc.onion' })
  })

  it('turns red for an NCC failure', () => {
    expect(
      securitySummary(
        nav({
          mode: 'ncc',
          displayUrl: 'ncc://npub/web/',
          failure: { code: 'k-mismatch', message: 'mismatch' }
        })
      )
    ).toMatchObject({ tone: 'danger', label: 'failure' })
  })
})
