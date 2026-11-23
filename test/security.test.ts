import { describe, expect, it } from 'vitest'
import type { ResolvedEndpoint } from '../src/shared/types'
import {
  isAuthPopupUrl,
  isDialogSizedPopupFeatures,
  isHttpExemptUrl,
  isLoopbackHost,
  nccEndpointNeedsWarning,
  shouldUpgradeHttp,
  upgradeToHttps
} from '../src/main/security'
import { sortCandidatesForHttps } from '../src/main/ncc/transport'

function endpoint(url: string): ResolvedEndpoint {
  return {
    url,
    protocol: url.startsWith('https') ? 'https' : 'http',
    priority: 1,
    family: url.includes('.onion') ? 'onion' : 'ipv4',
    k: null
  }
}

describe('HTTPS policy', () => {
  it('identifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.9.8.7')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })

  it('upgrades only non-exempt clearnet HTTP URLs', () => {
    expect(shouldUpgradeHttp('http://example.com/a', 'prefer')).toBe(true)
    expect(shouldUpgradeHttp('http://example.com/a', 'only')).toBe(true)
    expect(shouldUpgradeHttp('http://example.com/a', 'off')).toBe(false)
    expect(shouldUpgradeHttp('https://example.com/a', 'prefer')).toBe(false)
    expect(shouldUpgradeHttp('http://127.0.0.1:8080/', 'prefer')).toBe(false)
    expect(shouldUpgradeHttp('http://abc.onion/', 'prefer')).toBe(false)
    expect(isHttpExemptUrl('http://localhost:5173/')).toBe(true)
  })

  it('keeps the port and drops the default HTTP port', () => {
    expect(upgradeToHttps('http://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(upgradeToHttps('http://example.com:8080/a')).toBe('https://example.com:8080/a')
    expect(upgradeToHttps('http://example.com:80/a')).toBe('https://example.com/a')
  })

  it('never warns for loopback or onion NCC endpoints', () => {
    expect(nccEndpointNeedsWarning(endpoint('http://127.0.0.1:8080/'))).toBe(false)
    expect(nccEndpointNeedsWarning(endpoint('http://abc.onion/'))).toBe(false)
    expect(nccEndpointNeedsWarning(endpoint('http://example.com/'))).toBe(true)
    expect(nccEndpointNeedsWarning(endpoint('https://example.com/'))).toBe(false)
  })

  it('puts published HTTPS endpoints first when HTTPS is preferred', () => {
    const http = endpoint('http://example.com:8080/')
    const https = endpoint('https://example.com:8443/')
    expect(sortCandidatesForHttps([http, https], 'prefer')).toEqual([https, http])
    expect(sortCandidatesForHttps([http, https], 'off')).toEqual([http, https])
  })
})

describe('isAuthPopupUrl', () => {
  it('recognizes known identity-provider popup hosts', () => {
    expect(isAuthPopupUrl('https://accounts.google.com/o/oauth2/auth')).toBe(true)
    expect(isAuthPopupUrl('https://appleid.apple.com/auth/authorize')).toBe(true)
  })

  it('rejects everything else, including lookalike or subdomain hosts', () => {
    expect(isAuthPopupUrl('https://example.com')).toBe(false)
    expect(isAuthPopupUrl('https://accounts.google.com.evil.example/')).toBe(false)
    expect(isAuthPopupUrl('https://evil.accounts.google.com/')).toBe(false)
    expect(isAuthPopupUrl('not a url')).toBe(false)
  })
})

describe('isDialogSizedPopupFeatures', () => {
  it('accepts popups sized like a sign-in or payment dialog', () => {
    // Figma's "Continue with Google" button: window.open('/start_google_sso', '', features)
    expect(isDialogSizedPopupFeatures('width=600,height=600')).toBe(true)
    expect(isDialogSizedPopupFeatures('width=300,height=300')).toBe(true)
    expect(isDialogSizedPopupFeatures('width=800,height=800')).toBe(true)
    expect(isDialogSizedPopupFeatures('left=100,top=100,width=500,height=650,resizable=yes')).toBe(true)
  })

  it('rejects popups missing a dimension or outside the dialog size range', () => {
    expect(isDialogSizedPopupFeatures('')).toBe(false)
    expect(isDialogSizedPopupFeatures('width=600')).toBe(false)
    expect(isDialogSizedPopupFeatures('height=600')).toBe(false)
    expect(isDialogSizedPopupFeatures('width=200,height=200')).toBe(false)
    expect(isDialogSizedPopupFeatures('width=1200,height=900')).toBe(false)
    expect(isDialogSizedPopupFeatures('width=abc,height=600')).toBe(false)
  })
})
