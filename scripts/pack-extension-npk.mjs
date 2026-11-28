/**
 * Pack a built extension (.nccx/.zip) as an npack package of kind navigator-extension.
 * Publishes nothing; it prints the `npack publish` command to run.
 *
 * Usage: node scripts/pack-extension-npk.mjs <package.nccx> <name> <publisher npub|hex> [outdir]
 *
 * The publisher and name are the extension's permanent identity, so the name is always
 * given rather than derived from the display name, which may change.
 *
 * Needs `npack` and `unzip` on PATH.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [input, name, publisher, outdir = 'release'] = process.argv.slice(2)
if (!input || !name || !publisher) {
  console.error('usage: node scripts/pack-extension-npk.mjs <package.nccx> <name> <publisher> [outdir]')
  process.exit(2)
}
if (name.length > 128 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
  console.error('The package name must be lowercase letters and digits, separated by hyphens')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'ncc-extension-npk-'))
try {
  const unpacked = join(work, 'unpacked')
  execFileSync('unzip', ['-q', resolve(input), '-d', unpacked], { stdio: 'inherit' })
  const manifest = JSON.parse(readFileSync(join(unpacked, 'manifest.json'), 'utf8'))
  const version = String(manifest.version)
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`A signed release needs a semantic version, not "${version}"`)
  }

  const source = join(work, 'package')
  execFileSync(
    'npack',
    ['init', source, '--name', name, '--version', version, '--publisher', publisher, '--kind', 'navigator-extension'],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  execFileSync('cp', ['-a', unpacked, join(source, 'extension')])

  const metadataPath = join(source, '.npack/manifest.json')
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  metadata.app = {
    ...metadata.app,
    summary: String(manifest.description || manifest.name).slice(0, 140)
  }
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)

  mkdirSync(resolve(outdir), { recursive: true })
  const base = join(resolve(outdir), `${name}-${version}-any-any`)
  if (existsSync(`${base}.npk`)) rmSync(`${base}.npk`)
  execFileSync('npack', ['pack', source, '--output', `${base}.npk`], { stdio: 'inherit' })
  execFileSync('npack', ['manifest', `${base}.npk`, '--output', `${base}.manifest.json`], { stdio: 'inherit' })
  execFileSync('npack', ['verify', `${base}.manifest.json`], { stdio: 'inherit' })

  console.log(`
To publish, upload to a Blossom server and/or name an HTTPS address that already
serves this exact file:

  npack publish ${base}.manifest.json --server <blossom-url> --relay <relay-url>
  npack publish ${base}.manifest.json --artifact-url <https-url> --relay <relay-url>

Warning: if your npack config lists Blossom servers, publish uploads the file to them
even when you give only --artifact-url. Never use publish for a private or test file.`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
