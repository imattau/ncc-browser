#!/usr/bin/env node
/**
 * Download the pinned Tor Expert Bundle and stage it under resources/tor/<target>/.
 *
 *   node scripts/fetch-tor.mjs                 # this machine
 *   node scripts/fetch-tor.mjs linux-x64       # one target
 *   node scripts/fetch-tor.mjs --all           # every release target
 *
 * The Tor version and per-asset SHA-256 live in tor-version.json. Treat a Tor
 * update as a security update: bump both together.
 */

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'tor-version.json'), 'utf8'))
const targets = Object.keys(manifest.bundles)

const args = process.argv.slice(2)
const all = args.includes('--all')
const force = args.includes('--force')
const requested = args.filter((arg) => !arg.startsWith('-'))
const hostTarget = `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`

const selected = all ? targets : requested.length ? requested : [hostTarget]
for (const target of selected) {
  if (!manifest.bundles[target]) {
    console.error(`Unknown Tor target "${target}". Choose one of: ${targets.join(', ')}`)
    process.exit(1)
  }
}

for (const target of selected) {
  await fetchBundle(target)
}

async function fetchBundle(target) {
  const bundle = manifest.bundles[target]
  const destination = join(root, 'resources', 'tor', target)
  const binary = join(destination, 'tor', target.startsWith('win-') ? 'tor.exe' : 'tor')

  if (
    !force &&
    existsSync(binary) &&
    existsSync(join(destination, 'TOR-LICENSE.txt'))
  ) {
    console.log(`${target}: already staged at ${destination}`)
    return
  }

  const url = `${manifest.baseUrl}/${manifest.version}/${bundle.asset}`
  console.log(`${target}: downloading ${bundle.asset} (${manifest.version})`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${target}: ${response.status} ${response.statusText} for ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== bundle.sha256) {
    throw new Error(`${target}: checksum mismatch\n  expected ${bundle.sha256}\n  actual   ${digest}`)
  }

  const work = mkdtempSync(join(tmpdir(), `ncc-tor-${target}-`))
  try {
    const archive = join(work, bundle.asset)
    writeFileSync(archive, bytes)
    const extracted = join(work, 'bundle')
    mkdirSync(extracted, { recursive: true })
    const tar = spawnSync('tar', ['-xzf', archive, '-C', extracted], { stdio: 'inherit' })
    if (tar.status !== 0) {
      throw new Error(`${target}: could not extract ${bundle.asset} (is tar installed?)`)
    }

    const source = join(extracted, 'tor')
    const data = join(extracted, 'data')
    if (!existsSync(join(source, target.startsWith('win-') ? 'tor.exe' : 'tor'))) {
      throw new Error(`${target}: archive does not contain tor/${target.startsWith('win-') ? 'tor.exe' : 'tor'}`)
    }

    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    // Tor's browser binaries live in tor/ and its geoip files in data/. The debug
    // symbols, docs and unused pluggable transports are not needed by the app.
    copyTree(source, join(destination, 'tor'), (name) => name === 'pluggable_transports')
    if (existsSync(data)) copyTree(data, join(destination, 'data'))
    const license = join(root, 'resources', 'tor', 'TOR-LICENSE.txt')
    if (existsSync(license)) copyFileSync(license, join(destination, 'TOR-LICENSE.txt'))
    writeFileSync(
      join(destination, 'TOR-NOTICE.txt'),
      `Bundled Tor ${manifest.version} (Tor Expert Bundle)\n` +
        `Source: ${manifest.baseUrl}/${manifest.version}/${bundle.asset}\n` +
        `License: see TOR-LICENSE.txt (Tor's BSD-3-Clause license).\n` +
        `The bundled tor binary reports that this build is covered by the GNU GPLv3;\n` +
        `see https://www.gnu.org/licenses/gpl-3.0.en.html and the Tor Project sources.\n`
    )
    try {
      chmodSync(join(destination, 'tor', target.startsWith('win-') ? 'tor.exe' : 'tor'), 0o755)
    } catch {
      // Windows does not have POSIX permissions.
    }
    console.log(`${target}: staged ${destination}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function copyTree(from, to, skip = () => false) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target, skip)
    else copyFileSync(source, target)
  }
}
