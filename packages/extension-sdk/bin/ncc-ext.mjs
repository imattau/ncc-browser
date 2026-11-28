#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const SUPPORTED_PERMISSIONS = new Set([
  'storage',
  'notifications',
  'contextMenus',
  'tabs',
  'scripting',
  'clipboardWrite',
  'nostr:pubkey',
  'nostr:profile',
  'nostr:sign',
  'nostr:nip04',
  'nostr:nip44',
  'blossom:group-image'
])

const SUPPORTED_APIS = [
  /^chrome\.runtime\.(sendMessage|getURL|getManifest|getPlatformInfo|onMessage|onInstalled|onStartup|id|lastError)\b/,
  /^chrome\.storage\.(local|sync|session|onChanged)\b/,
  /^chrome\.tabs\.(query|get|create|update|remove|sendMessage|reload)\b/,
  /^chrome\.scripting\.executeScript\b/,
  /^chrome\.action\.onClicked\b/,
  /^chrome\.contextMenus\.(create|remove|removeAll|onClicked)\b/,
  /^chrome\.notifications\.create\b/,
  /^chrome\.i18n\.getMessage\b/,
  /^chrome\.extension\.(getURL|getBackgroundPage|lastError)\b/,
  /^chrome\.runtime\.connect\b/
]

const UNSUPPORTED_HINTS = {
  'chrome.runtime.connect': 'Message ports are not supported; use runtime.sendMessage or tabs.sendMessage.',
  'chrome.webRequest': 'Network interception is not implemented. Declarative rules may be added later.',
  'chrome.declarativeNetRequest': 'Blocking network rules are not implemented.',
  'chrome.cookies': 'Cookie access is intentionally unavailable.',
  'chrome.history': 'History access is intentionally unavailable.',
  'chrome.bookmarks': 'Use the browser UI or NCC APIs instead.',
  'chrome.downloads': 'Downloads are managed by the browser.',
  'chrome.identity': 'Use ncc.nostr for identity operations.',
  'chrome.offscreen': 'Offscreen documents are not supported.',
  'chrome.sidePanel': 'Side panels are not implemented.',
  'chrome.devtools': 'DevTools panels are not implemented.',
  'chrome.management': 'Extension management is owned by the browser.',
  'chrome.omnibox': 'Omnibox keywords are not implemented.',
  'chrome.commands': 'Extension keyboard commands are not implemented.',
  'chrome.alarms': 'Alarms are not implemented; use background events.'
}

function usage() {
  console.log(`ncc-ext <command> [options]

Commands:
  init <dir>                 Scaffold a minimal extension
  validate <dir>             Validate manifest.json and referenced files
  port <dir> [--ncc]         Convert a Chromium MV3 extension and write a report
  pack <dir> [out.nccx]      Create a zip/zip-compatible .nccx package

Options:
  --ncc                      Add ncc://*/* to content script matches while porting
  --force                    Overwrite existing files during init
`)
}

function main(argv) {
  const [command, ...rest] = argv
  const args = rest.filter((value) => !value.startsWith('--'))
  const flags = new Set(rest.filter((value) => value.startsWith('--')))
  if (!command || command === '--help' || command === '-h') {
    usage()
    return 0
  }
  if (command === 'init') return init(args[0], flags.has('--force'))
  if (command === 'validate') return validate(args[0])
  if (command === 'port') return port(args[0], flags.has('--ncc'))
  if (command === 'pack') return pack(args[0], args[1])
  console.error(`Unknown command: ${command}`)
  usage()
  return 1
}

function init(dir, force) {
  if (!dir) throw new Error('init needs a target directory')
  const root = resolve(dir)
  mkdirSync(root, { recursive: true })
  const files = {
    'manifest.json': `${JSON.stringify(
      {
        manifest_version: 3,
        name: 'My NCC extension',
        version: '1.0.0',
        description: 'A small NCC browser extension',
        permissions: ['storage'],
        host_permissions: ['ncc://*/*'],
        background: { service_worker: 'background.js', type: 'module' },
        content_scripts: [
          {
            matches: ['ncc://*/*'],
            js: ['content.js'],
            run_at: 'document_idle'
          }
        ],
        action: { default_title: 'My NCC extension', default_popup: 'popup.html' },
        ncc: { min_version: '0.6.0' }
      },
      null,
      2
    )}\n`,
    'content.js': `document.documentElement.dataset.myNccExtension = '1'\nconsole.log('My NCC extension loaded on', location.href)\n`,
    'background.js': `chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {\n  if (message && message.type === 'ping') sendResponse({ ok: true })\n  return true\n})\n`,
    'popup.html': `<!doctype html>\n<html><head><meta charset="utf-8"><title>My NCC extension</title></head>\n<body><p>Hello from an NCC extension.</p><script src="popup.js"></script></body></html>\n`,
    'popup.js': `document.body.append(' URL: ' + location.origin)\n`
  }
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    if (existsSync(path) && !force) {
      console.warn(`skip ${name} (exists; use --force to overwrite)`)
      continue
    }
    writeFileSync(path, content)
  }
  console.log(`Created ${root}`)
  return 0
}

function readManifest(dir) {
  if (!dir) throw new Error('A directory is required')
  const root = resolve(dir)
  const path = join(root, 'manifest.json')
  if (!existsSync(path)) throw new Error(`No manifest.json in ${root}`)
  return { root, manifest: JSON.parse(readFileSync(path, 'utf8')) }
}

function validate(dir) {
  const { root, manifest } = readManifest(dir)
  const errors = []
  const warnings = []
  if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3')
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name is required')
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) errors.push('version is required')

  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
  for (const permission of permissions) {
    if (!SUPPORTED_PERMISSIONS.has(permission)) {
      warnings.push(`permission "${permission}" is not supported and will be ignored`)
    }
  }
  const hosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []
  for (const host of hosts) {
    if (!/^(\*|https?|ncc):\/\/[^/]+\/.*$/.test(host) && host !== '<all_urls>') {
      errors.push(`invalid host pattern: ${host}`)
    }
  }
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  for (const [index, entry] of scripts.entries()) {
    if (!Array.isArray(entry.matches) || entry.matches.length === 0) {
      errors.push(`content_scripts[${index}] has no matches`)
    }
    for (const path of [...(entry.js ?? []), ...(entry.css ?? [])]) {
      checkFile(root, path, errors)
    }
  }
  if (manifest.background?.service_worker) checkFile(root, manifest.background.service_worker, errors)
  if (manifest.action?.default_popup) checkFile(root, manifest.action.default_popup, errors)
  if (manifest.action?.default_icon && typeof manifest.action.default_icon === 'string') {
    checkFile(root, manifest.action.default_icon, errors)
  }
  for (const path of Object.values(manifest.icons ?? {})) checkFile(root, path, errors)

  const report = scanApis(root)
  warnings.push(...report.unsupported.map((api) => `${api} is not supported`))

  for (const warning of warnings) console.warn(`warning: ${warning}`)
  for (const error of errors) console.error(`error: ${error}`)
  if (errors.length === 0) console.log(`OK: ${manifest.name} ${manifest.version}`)
  return errors.length === 0 ? 0 : 1
}

function checkFile(root, path, errors) {
  if (typeof path !== 'string') {
    errors.push('non-string file path in manifest')
    return
  }
  const target = resolve(root, path)
  if (!target.startsWith(`${resolve(root)}/`) && target !== resolve(root)) {
    errors.push(`path escapes the extension: ${path}`)
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    errors.push(`missing file: ${path}`)
  }
}

function port(dir, includeNcc) {
  const { root, manifest } = readManifest(dir)
  if (manifest.manifest_version !== 3) {
    throw new Error('Only Manifest V3 extensions can be ported')
  }
  const warnings = []
  const next = structuredClone(manifest)
  if (next.browser_action && !next.action) {
    next.action = next.browser_action
    delete next.browser_action
    warnings.push('browser_action was rewritten as action')
  }
  if (next.page_action && !next.action) {
    next.action = next.page_action
    delete next.page_action
    warnings.push('page_action was rewritten as action')
  }
  if (next.options_page && !next.options_ui) {
    next.options_ui = { page: next.options_page }
    delete next.options_page
    warnings.push('options_page was rewritten as options_ui')
  }
  if (Array.isArray(next.permissions)) {
    const removed = next.permissions.filter((permission) => !SUPPORTED_PERMISSIONS.has(permission))
    next.permissions = next.permissions.filter((permission) => SUPPORTED_PERMISSIONS.has(permission))
    for (const permission of removed) {
      warnings.push(`removed unsupported permission: ${permission}`)
    }
  }
  if (Array.isArray(next.content_scripts) && includeNcc) {
    for (const entry of next.content_scripts) {
      if (!Array.isArray(entry.matches)) continue
      if (!entry.matches.some((match) => match.startsWith('ncc://'))) {
        entry.matches.push('ncc://*/*')
      }
    }
    next.host_permissions = Array.isArray(next.host_permissions) ? next.host_permissions : []
    if (!next.host_permissions.some((match) => match.startsWith('ncc://'))) {
      next.host_permissions.push('ncc://*/*')
    }
    warnings.push('added ncc://*/* to content script matches and host permissions')
  }
  next.ncc = { ...(next.ncc ?? {}), min_version: next.ncc?.min_version ?? '0.6.0' }

  const apiReport = scanApis(root)
  const backup = join(root, 'manifest.chromium.json')
  if (!existsSync(backup)) writeFileSync(backup, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(next, null, 2)}\n`)
  writeFileSync(
    join(root, 'port-report.md'),
    `# NCC extension port report\n\n` +
      `Source: ${root}\n\n` +
      `## Changes\n\n` +
      (warnings.length ? warnings.map((line) => `- ${line}`).join('\n') : '- None') +
      `\n\n## Unsupported APIs\n\n` +
      (apiReport.unsupported.length
        ? apiReport.unsupported
            .map((api) => `- \`${api}\` — ${UNSUPPORTED_HINTS[api] ?? 'Not implemented in this version.'}`)
            .join('\n')
        : '- None detected') +
      `\n\n## Supported APIs found\n\n` +
      (apiReport.supported.length
        ? [...new Set(apiReport.supported)].map((api) => `- \`${api}\``).join('\n')
        : '- None') +
      `\n\n## Manual checks\n\n` +
      `- Verify \`chrome.runtime.connect\` is not required.\n` +
      `- Check host permissions for both https:// and ncc:// pages.\n` +
      `- Private tabs are a per-extension grant; content scripts can read private pages.\n` +
      `- Nostr calls require the \`nostr:*\` manifest permissions and still prompt for approval.\n`
  )
  console.log(`Ported ${next.name} ${next.version}`)
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  for (const api of apiReport.unsupported) console.warn(`unsupported: ${api}`)
  console.log(`Report: ${join(root, 'port-report.md')}`)
  return 0
}

function scanApis(root) {
  const supported = []
  const unsupported = []
  const files = listFiles(root).filter((path) => /\.(js|mjs|cjs|ts)$/.test(path))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/chrome\s*\.\s*([A-Za-z0-9_]+)\s*\.\s*([A-Za-z0-9_]+)/g)) {
      const api = `chrome.${match[1]}.${match[2]}`
      const base = Object.keys(UNSUPPORTED_HINTS).find((key) => api.startsWith(key))
      if (base) {
        if (!unsupported.includes(base)) unsupported.push(base)
        continue
      }
      if (SUPPORTED_APIS.some((pattern) => pattern.test(api))) {
        if (!supported.includes(api)) supported.push(api)
      } else if (!unsupported.includes(api)) {
        unsupported.push(api)
      }
    }
  }
  return { supported, unsupported }
}

function pack(dir, out) {
  const { root, manifest } = readManifest(dir)
  const destination = resolve(out ?? join(dirname(root), `${basename(root)}.nccx`))
  const files = listFiles(root).map((path) => relative(root, path))
  if (files.some((path) => path.startsWith('port-report') || path.startsWith('manifest.chromium'))) {
    // Reports are useful locally but should not ship in the package.
  }
  const entries = files
    .filter((path) => path !== 'port-report.md' && path !== 'manifest.chromium.json')
    .map((path) => ({ name: path.replaceAll('\\', '/'), data: readFileSync(join(root, path)) }))
  writeFileSync(destination, buildZip(entries))
  console.log(`Packed ${manifest.name} ${manifest.version} → ${destination}`)
  return 0
}

function listFiles(root, current = root) {
  const result = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) result.push(...listFiles(root, path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
