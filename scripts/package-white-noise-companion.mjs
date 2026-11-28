import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'extensions/white-noise-prototype')
const version = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')).version
const output = resolve(process.argv[2] ?? join(root, `extensions/white-noise-companion-${version}.nccx`))
const stage = mkdtempSync(join(tmpdir(), 'ncc-white-noise-companion-'))
const runtimeFiles = ['manifest.json', 'icon.svg', 'panel.css', 'panel.html', 'panel.js', 'marmot.bundle.js']
const cli = join(root, 'packages/extension-sdk/bin/ncc-ext.mjs')

try {
  for (const file of runtimeFiles) cpSync(join(source, file), join(stage, file))
  mkdirSync(dirname(output), { recursive: true })
  execFileSync(process.execPath, [cli, 'validate', stage], { cwd: root, stdio: 'inherit' })
  execFileSync(process.execPath, [cli, 'pack', stage, output], { cwd: root, stdio: 'inherit' })
} finally {
  rmSync(stage, { recursive: true, force: true })
}

console.log(`Prepared ${basename(output)}`)
