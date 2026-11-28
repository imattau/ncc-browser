/**
 * NCC extension model: an MV3-shaped manifest plus the pieces the runtime needs to
 * decide where content scripts run. Everything here is pure and shared by the main
 * process, the preloads and tests.
 */

import type { TabKind } from './types'

export const EXTENSION_SCHEME = 'ncc-ext'
export const EXTENSION_STATE_VERSION = 1
export const MAX_EXTENSION_BYTES = 50 * 1024 * 1024
export const MAX_EXTENSION_FILES = 5_000
export const MAX_SCRIPT_BYTES = 2 * 1024 * 1024
export const MAX_CSS_BYTES = 1024 * 1024
export const MAX_ICON_BYTES = 256 * 1024
export const MAX_NAME = 100
export const MAX_DESCRIPTION = 500

export type ExtensionSource = 'folder' | 'zip' | 'store' | 'test'
export type ExtensionRunAt = 'document_start' | 'document_end' | 'document_idle'
export type ExtensionStorageArea = 'local' | 'sync' | 'session' | 'private'

export interface ExtensionContentScript {
  matches: string[]
  js: string[]
  css: string[]
  run_at: ExtensionRunAt
  all_frames: boolean
}

export interface ExtensionActionManifest {
  default_title: string
  default_popup: string | null
  default_icon: string | null
}

export interface ExtensionManifest {
  manifest_version: 3
  name: string
  version: string
  description: string
  author?: string
  permissions: string[]
  host_permissions: string[]
  background: { service_worker: string; type: 'module' | 'classic' } | null
  content_scripts: ExtensionContentScript[]
  action: ExtensionActionManifest | null
  options_page: string | null
  icons: Record<string, string>
  web_accessible_resources: string[]
  ncc: { min_version?: string; side_panel?: string }
}

export interface NormalizedManifest {
  manifest: ExtensionManifest
  warnings: string[]
}

/** A signed install. Its identity is the publisher key plus the package name. */
export interface ExtensionStoreOrigin {
  /** Hex public key. */
  publisher: string
  name: string
  releaseId: string
  /** Hash of the installed package, so a revocation of the same bytes is recognised. */
  sha256: string
  /** Set once the publisher revokes the installed release. */
  revoked: string | null
}

export interface ExtensionSigner {
  npub: string
  name: string
}

export type ExtensionUpdateResult =
  | { ok: true; review: ExtensionInstallReview | null; message: string }
  | { ok: false; error: string }

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  description: string
  author: string
  source: ExtensionSource
  sourcePath: string
  installPath: string
  enabled: boolean
  privateTabs: boolean
  installedAt: number
  updatedAt: number
  permissions: string[]
  hostPermissions: string[]
  warnings: string[]
  error: string | null
  iconDataUrl: string | null
  hasOptions: boolean
  hasBackground: boolean
  hasPopup: boolean
  contentScriptCount: number
  /** Present for signed installs. */
  signed: (ExtensionSigner & { revoked: string | null }) | null
}

export interface ExtensionActionInfo {
  extensionId: string
  title: string
  iconDataUrl: string | null
  hasPopup: boolean
}

export interface ExtensionsState {
  developerMode: boolean
  extensions: ExtensionInfo[]
  actions: ExtensionActionInfo[]
}

export interface ExtensionInstallResult {
  ok: boolean
  error?: string
  extension?: ExtensionInfo
}

/** What the user is asked to approve. Nothing is installed until they do. */
export interface ExtensionInstallReview {
  /** Main-process handle for the staged copy; the bytes reviewed are the bytes installed. */
  token: string
  name: string
  version: string
  description: string
  author: string
  source: ExtensionSource
  sourcePath: string
  /** Set when approving would replace an installed extension. */
  replaces: { name: string; version: string } | null
  permissions: ExtensionAccessItem[]
  sites: ExtensionAccessItem[]
  /** Who signed the release, or null for an unsigned local package. */
  signed: ExtensionSigner | null
  /** Problems in the manifest, such as unsupported permissions. */
  notices: string[]
  /** Starting value for the "Run in private tabs" choice. */
  privateTabs: boolean
}

export interface ExtensionAccessItem {
  id: string
  label: string
  /** True when this is an update and the installed version did not have it. */
  added: boolean
}

export type ExtensionPrepareResult =
  | { ok: true; review: ExtensionInstallReview }
  | { ok: false; error: string }

export interface ExtensionPage {
  /** Chrome-style numeric tab id: the WebContents id. */
  id: number
  tabId: string
  kind: TabKind
  url: string
  title: string
  active: boolean
  incognito: boolean
}

export interface ExtensionPlanEntry {
  extensionId: string
  worldId: number
  runAt: ExtensionRunAt
  code: string
  css: string
  manifest: ExtensionManifest
}

export interface ExtensionSender {
  extensionId: string
  from: 'content' | 'page' | 'background'
  tab: ExtensionPage | null
  incognito: boolean
  extensionPagePath?: string
}

export const SUPPORTED_PERMISSIONS = new Set([
  'storage',
  'storage:large',
  'notifications',
  'contextMenus',
  'tabs',
  'scripting',
  'alarms',
  'clipboardWrite',
  'blossom:group-image',
  'contacts:read',
  'nostr:pubkey',
  'nostr:profile',
  'nostr:sign',
  'nostr:nip04',
  'nostr:nip44'
])

const PERMISSION_WARNINGS: Record<string, string> = {
  storage: 'Store data locally',
  'storage:large': 'Store up to 128 MB of local data',
  notifications: 'Show notifications',
  contextMenus: 'Add items to the page context menu',
  tabs: 'Read the address and title of your open tabs',
  scripting: 'Run its own scripts on matching pages',
  alarms: 'Schedule background work',
  clipboardWrite: 'Write to the clipboard',
  'blossom:group-image': 'Upload encrypted group photos to approved Blossom servers',
  'contacts:read': 'Read the active profile’s public contact list',
  'nostr:pubkey': 'Read your public key',
  'nostr:profile': 'Read public profile names and photos',
  'nostr:sign': 'Ask you to sign Nostr events',
  'nostr:nip04': 'Encrypt and decrypt NIP-04 messages',
  'nostr:nip44': 'Encrypt and decrypt NIP-44 messages'
}

export function permissionWarnings(manifest: ExtensionManifest): string[] {
  const warnings: string[] = []
  for (const permission of manifest.permissions) {
    const label = PERMISSION_WARNINGS[permission]
    if (label) warnings.push(label)
    else warnings.push(`Unknown permission "${permission}" (ignored)`)
  }
  for (const site of siteAccess(manifest)) {
    warnings.push(`Read and change data on ${site}`)
  }
  return warnings
}

/**
 * Every pattern that lets an extension act on a page. A content script match grants
 * access on its own, so `host_permissions` alone would understate it.
 */
export function siteAccess(manifest: ExtensionManifest): string[] {
  return [
    ...new Set([
      ...manifest.host_permissions,
      ...manifest.content_scripts.flatMap((script) => script.matches)
    ])
  ]
}

/**
 * The access to show for approval. Patterns are compared as text, so a rewritten
 * pattern is reported as new even if it covers no more than before.
 */
export function reviewAccess(
  manifest: ExtensionManifest,
  installed: ExtensionManifest | null
): { permissions: ExtensionAccessItem[]; sites: ExtensionAccessItem[] } {
  const hadPermissions = new Set(installed?.permissions ?? [])
  const hadSites = new Set(installed ? siteAccess(installed) : [])
  return {
    permissions: [...new Set(manifest.permissions)].map((id) => ({
      id,
      label: PERMISSION_WARNINGS[id] ?? `Unknown permission "${id}" (ignored)`,
      added: installed !== null && !hadPermissions.has(id)
    })),
    sites: siteAccess(manifest).map((id) => ({
      id,
      label: id,
      added: installed !== null && !hadSites.has(id)
    }))
  }
}

export function hasPermission(manifest: ExtensionManifest, permission: string): boolean {
  return manifest.permissions.includes(permission)
}

export function normalizeExtensionManifest(input: unknown): NormalizedManifest {
  if (!input || typeof input !== 'object') throw new Error('manifest.json must be an object')
  const raw = input as Record<string, unknown>
  if (raw.manifest_version !== 3) {
    throw new Error(
      raw.manifest_version === 2
        ? 'Manifest V2 is not supported. Port the extension to Manifest V3.'
        : 'manifest_version must be 3'
    )
  }

  const name = text(raw.name, 'name', MAX_NAME, 1)
  const version = text(raw.version, 'version', 32, 1)
  if (!/^[0-9]+(\.[0-9]+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('version must look like 1.2.3')
  }
  const description = optionalText(raw.description, MAX_DESCRIPTION) ?? ''
  const author = optionalText(raw.author, 200) ?? ''

  const warnings: string[] = []
  const permissions = stringArray(raw.permissions, 'permissions').filter((permission) => {
    if (SUPPORTED_PERMISSIONS.has(permission)) return true
    warnings.push(`Permission "${permission}" is not supported and will be ignored.`)
    return false
  })
  const hostPermissions = stringArray(raw.host_permissions, 'host_permissions')
  for (const pattern of hostPermissions) {
    if (!isValidMatchPattern(pattern)) {
      throw new Error(`host_permissions contains an invalid match pattern: ${pattern}`)
    }
  }

  let background: ExtensionManifest['background'] = null
  if (raw.background !== undefined) {
    if (!raw.background || typeof raw.background !== 'object') {
      throw new Error('background must be an object')
    }
    const value = raw.background as Record<string, unknown>
    const worker = value.service_worker
    if (typeof worker !== 'string') {
      throw new Error('background.service_worker is required (MV3 only)')
    }
    background = {
      service_worker: safeRelativePath(worker, 'background.service_worker'),
      type: value.type === 'module' ? 'module' : 'classic'
    }
  }

  const contentScripts: ExtensionContentScript[] = []
  if (raw.content_scripts !== undefined) {
    if (!Array.isArray(raw.content_scripts)) throw new Error('content_scripts must be an array')
    for (const [index, value] of raw.content_scripts.entries()) {
      if (!value || typeof value !== 'object') {
        throw new Error(`content_scripts[${index}] must be an object`)
      }
      const entry = value as Record<string, unknown>
      const matches = stringArray(entry.matches, `content_scripts[${index}].matches`)
      if (matches.length === 0) {
        throw new Error(`content_scripts[${index}] needs at least one match pattern`)
      }
      for (const pattern of matches) {
        if (!isValidMatchPattern(pattern)) {
          throw new Error(`content_scripts[${index}] has an invalid match pattern: ${pattern}`)
        }
      }
      const js = stringArray(entry.js, `content_scripts[${index}].js`).map((path) =>
        safeRelativePath(path, `content_scripts[${index}].js`)
      )
      const css = stringArray(entry.css, `content_scripts[${index}].css`).map((path) =>
        safeRelativePath(path, `content_scripts[${index}].css`)
      )
      if (js.length === 0 && css.length === 0) {
        throw new Error(`content_scripts[${index}] needs js or css files`)
      }
      const runAt = normalizeRunAt(entry.run_at)
      if (entry.all_frames === true) {
        warnings.push('all_frames is not supported yet; scripts run in the top frame only.')
      }
      contentScripts.push({ matches, js, css, run_at: runAt, all_frames: false })
    }
  }

  let action: ExtensionActionManifest | null = null
  if (raw.action !== undefined) {
    if (!raw.action || typeof raw.action !== 'object') throw new Error('action must be an object')
    const value = raw.action as Record<string, unknown>
    action = {
      default_title: optionalText(value.default_title, MAX_NAME) ?? name,
      default_popup:
        typeof value.default_popup === 'string'
          ? safeRelativePath(value.default_popup, 'action.default_popup')
          : null,
      default_icon: normalizeIconValue(value.default_icon, warnings)
    }
  }

  let optionsPage: string | null = null
  if (raw.options_ui !== undefined) {
    if (!raw.options_ui || typeof raw.options_ui !== 'object') {
      throw new Error('options_ui must be an object')
    }
    const value = raw.options_ui as Record<string, unknown>
    if (typeof value.page !== 'string') throw new Error('options_ui.page is required')
    optionsPage = safeRelativePath(value.page, 'options_ui.page')
  } else if (typeof raw.options_page === 'string') {
    optionsPage = safeRelativePath(raw.options_page, 'options_page')
  }

  const icons = normalizeIcons(raw.icons)
  const webAccessible = normalizeWebAccessible(raw.web_accessible_resources)

  const rawNcc = raw.ncc && typeof raw.ncc === 'object'
    ? raw.ncc as Record<string, unknown>
    : {}
  const ncc: ExtensionManifest['ncc'] = {
    ...(typeof rawNcc.min_version === 'string' ? { min_version: rawNcc.min_version } : {}),
    ...(typeof rawNcc.side_panel === 'string'
      ? { side_panel: safeRelativePath(rawNcc.side_panel, 'ncc.side_panel') }
      : {})
  }

  return {
    manifest: {
      manifest_version: 3,
      name,
      version,
      description,
      ...(author ? { author } : {}),
      permissions,
      host_permissions: hostPermissions,
      background,
      content_scripts: contentScripts,
      action,
      options_page: optionsPage,
      icons,
      web_accessible_resources: webAccessible,
      ncc
    },
    warnings
  }
}

function text(value: unknown, field: string, max: number, min: number): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length < min) throw new Error(`${field} is required`)
  if (trimmed.length > max) throw new Error(`${field} is too long`)
  return trimmed
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) throw new Error(`${field} must contain strings`)
    return entry.trim()
  })
}

function normalizeRunAt(value: unknown): ExtensionRunAt {
  if (value === 'document_start' || value === 'document_end' || value === 'document_idle') {
    return value
  }
  return 'document_idle'
}

function normalizeIcons(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('icons must be an object of size → path')
  }
  const result: Record<string, string> = {}
  for (const [size, path] of Object.entries(value)) {
    if (typeof path !== 'string') throw new Error('icons paths must be strings')
    if (!/^[0-9]+$/.test(size)) throw new Error('icons keys must be pixel sizes')
    result[size] = safeRelativePath(path, `icons.${size}`)
  }
  return result
}

function normalizeIconValue(value: unknown, warnings: string[]): string | null {
  if (typeof value === 'string') return safeRelativePath(value, 'action.default_icon')
  if (value && typeof value === 'object') {
    const icons = value as Record<string, unknown>
    const preferred = icons['128'] ?? icons['48'] ?? icons['32'] ?? Object.values(icons)[0]
    if (typeof preferred === 'string') {
      return safeRelativePath(preferred, 'action.default_icon')
    }
  }
  if (value !== undefined) warnings.push('action.default_icon could not be read.')
  return null
}

function normalizeWebAccessible(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('web_accessible_resources must be an array')
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      result.push(entry)
      continue
    }
    if (entry && typeof entry === 'object') {
      const resources = (entry as { resources?: unknown }).resources
      if (Array.isArray(resources)) {
        for (const resource of resources) {
          if (typeof resource === 'string') result.push(resource)
        }
      }
    }
  }
  return result.map((path) => path.replace(/^\/+/, '')).slice(0, 200)
}

/** Reject absolute, drive-letter, traversal and empty paths from a package manifest. */
export function safeRelativePath(value: string, field: string): string {
  const normalized = value.replace(/\\/g, '/').trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.startsWith('/')) throw new Error(`${field} must be relative`)
  if (/^[a-z]:/i.test(normalized)) throw new Error(`${field} must be relative`)
  if (normalized.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`${field} must not contain . or ..`)
  }
  if (normalized.includes('\u0000')) throw new Error(`${field} contains an invalid character`)
  return normalized
}

/** Path inside an extension package; returns null when it escapes the root. */
export function extensionPathInside(root: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) return root
  const parts = normalized.split('/')
  if (parts.some((part) => part === '..' || part === '' || part === '.')) return null
  return `${root}/${parts.join('/')}`
}

/* ------------------------------------------------------------------ */
/*  Match patterns                                                    */
/* ------------------------------------------------------------------ */

export interface ParsedMatchPattern {
  scheme: '*' | 'http' | 'https' | 'ncc'
  host: string
  path: string
}

export function parseMatchPattern(pattern: string): ParsedMatchPattern | null {
  const value = pattern.trim()
  if (value === '<all_urls>') return { scheme: '*', host: '*', path: '/*' }
  const match = /^(\*|https?|ncc):\/\/([^/]+)(\/.*)$/i.exec(value)
  if (!match) return null
  const scheme = match[1].toLowerCase() as ParsedMatchPattern['scheme']
  const host = match[2].toLowerCase()
  const path = match[3]
  if (!host || !path.startsWith('/')) return null
  if (scheme === 'ncc') {
    if (host !== '*' && !/^(npub1[02-9ac-hj-np-z]{20,}|[0-9a-f]{64})$/i.test(host)) return null
  } else if (host !== '*') {
    if (host.includes('*') && !host.startsWith('*.')) return null
    if (host.startsWith('*.')) {
      const rest = host.slice(2)
      if (!rest || rest.includes('*') || rest.includes('/')) return null
    } else if (host.includes('*')) {
      return null
    }
  }
  return { scheme, host, path }
}

export function isValidMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) != null
}

export function matchPattern(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern)
  if (!parsed) return false
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  const protocol = target.protocol.replace(':', '')
  if (parsed.scheme === '*') {
    if (protocol !== 'http' && protocol !== 'https') return false
  } else if (protocol !== parsed.scheme) {
    return false
  }

  const host = target.hostname.toLowerCase()
  if (parsed.host !== '*') {
    if (parsed.host.startsWith('*.')) {
      const suffix = parsed.host.slice(2)
      if (host !== suffix && !host.endsWith(`.${suffix}`)) return false
    } else if (host !== parsed.host) {
      return false
    }
  }

  return globMatch(parsed.path, target.pathname || '/')
}

export function matchesAny(patterns: string[], url: string): boolean {
  return patterns.some((pattern) => matchPattern(pattern, url))
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(value)
}
