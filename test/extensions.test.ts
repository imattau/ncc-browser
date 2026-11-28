import { describe, expect, it } from 'vitest'
import {
  isValidMatchPattern,
  matchPattern,
  normalizeExtensionManifest,
  permissionWarnings
} from '../src/shared/extensions'

const npub = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhs2n3v'

describe('extension match patterns', () => {
  it('matches web and ncc patterns', () => {
    expect(matchPattern('https://example.com/*', 'https://example.com/a?b=1')).toBe(true)
    expect(matchPattern('*://*.example.com/*', 'https://a.example.com/x')).toBe(true)
    expect(matchPattern('*://*.example.com/*', 'https://example.com/x')).toBe(true)
    expect(matchPattern('*://*.example.com/*', 'https://notexample.com/x')).toBe(false)
    expect(matchPattern('http://example.com/*', 'https://example.com/x')).toBe(false)
    expect(matchPattern('ncc://*/*', `ncc://${npub}/web/page`)).toBe(true)
    expect(matchPattern(`ncc://${npub}/web/*`, `ncc://${npub}/web/page`)).toBe(true)
    expect(matchPattern(`ncc://${npub}/web/*`, `ncc://${npub}/other/page`)).toBe(false)
    expect(matchPattern('ncc://*/web/*', `ncc://${npub}/web/page`)).toBe(true)
  })

  it('does not let the wildcard scheme match ncc URLs', () => {
    expect(matchPattern('*://*/*', `ncc://${npub}/web/`)).toBe(false)
  })

  it('rejects malformed patterns', () => {
    expect(isValidMatchPattern('https://example.com')).toBe(false)
    expect(isValidMatchPattern('ncc://not-a-pubkey/*')).toBe(false)
    expect(isValidMatchPattern('ftp://example.com/*')).toBe(false)
    expect(isValidMatchPattern('<all_urls>')).toBe(true)
  })
})

describe('manifest normalization', () => {
  it('normalizes an MV3 manifest and warns about unsupported permissions', () => {
    const result = normalizeExtensionManifest({
      manifest_version: 3,
      name: 'Test',
      version: '1.2.3',
      description: 'A test',
      permissions: ['storage', 'webRequest', 'nostr:sign'],
      host_permissions: ['https://example.com/*'],
      background: { service_worker: 'background.js', type: 'module' },
      content_scripts: [
        {
          matches: ['ncc://*/*'],
          js: ['content.js'],
          css: ['content.css'],
          run_at: 'document_start'
        }
      ],
      action: { default_title: 'Test', default_popup: 'popup.html' },
      options_page: 'options.html',
      icons: { '128': 'icon.png' }
    })
    expect(result.manifest.name).toBe('Test')
    expect(result.manifest.permissions).toEqual(['storage', 'nostr:sign'])
    expect(result.manifest.content_scripts[0].run_at).toBe('document_start')
    expect(result.manifest.options_page).toBe('options.html')
    expect(result.warnings.join(' ')).toContain('webRequest')
    expect(permissionWarnings(result.manifest)).toContain('Read and change data on https://example.com/*')
  })

  it('keeps the permissioned NCC contacts API available to extensions', () => {
    const result = normalizeExtensionManifest({
      manifest_version: 3,
      name: 'Contacts test',
      version: '1.0.0',
      permissions: ['contacts:read']
    })
    expect(result.manifest.permissions).toContain('contacts:read')
    expect(result.warnings).not.toContain('Permission "contacts:read" is not supported and will be ignored.')
    expect(permissionWarnings(result.manifest)).toContain('Read the active profile’s public contact list')
  })

  it('rejects MV2 and traversal paths', () => {
    expect(() =>
      normalizeExtensionManifest({ manifest_version: 2, name: 'x', version: '1' })
    ).toThrow(/Manifest V2/)
    expect(() =>
      normalizeExtensionManifest({
        manifest_version: 3,
        name: 'x',
        version: '1',
        content_scripts: [{ matches: ['ncc://*/*'], js: ['../evil.js'] }]
      })
    ).toThrow(/relative|\.\./)
  })

  it('requires valid match patterns and at least one script', () => {
    expect(() =>
      normalizeExtensionManifest({
        manifest_version: 3,
        name: 'x',
        version: '1',
        content_scripts: [{ matches: ['https://example.com'], js: ['a.js'] }]
      })
    ).toThrow(/invalid match pattern/)
    expect(() =>
      normalizeExtensionManifest({
        manifest_version: 3,
        name: 'x',
        version: '1',
        content_scripts: [{ matches: ['ncc://*/*'] }]
      })
    ).toThrow(/needs js or css/)
  })

  it('treats all_frames as a warning', () => {
    const result = normalizeExtensionManifest({
      manifest_version: 3,
      name: 'x',
      version: '1',
      content_scripts: [{ matches: ['https://example.com/*'], js: ['a.js'], all_frames: true }]
    })
    expect(result.manifest.content_scripts[0].all_frames).toBe(false)
    expect(result.warnings.join(' ')).toContain('all_frames')
  })
})
