// Fails when the desktop bundles load a package that the installed app will not have.
// electron-builder.yml leaves node_modules out of app.asar apart from the packages it
// names, so everything else must be bundled (see `exclude` in electron.vite.config.ts).
// Tests and `electron-vite dev` cannot catch this because node_modules is on disk.
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'

const builderConfig = readFileSync('electron-builder.yml', 'utf8')
const packaged = new Set(
  [...builderConfig.matchAll(/^\s*-\s+['"]?node_modules\/((?:@[^/]+\/)?[^/*'"\s]+)\//gm)].map((match) => match[1])
)

const problems = []
let checked = 0
for (const directory of ['out/main', 'out/preload']) {
  for (const file of readdirSync(directory, { recursive: true })) {
    if (!/\.[cm]?js$/.test(file)) continue
    checked += 1
    const source = readFileSync(join(directory, file), 'utf8')
    for (const [, , specifier] of source.matchAll(/\b(?:require|import)\(\s*(["'])([^"'./\n][^"'\n]*)\1\s*\)/g)) {
      const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
      if (name === 'electron' || isBuiltin(specifier) || packaged.has(name)) continue
      problems.push(`${join(directory, file)} loads "${specifier}"`)
    }
  }
}

if (checked === 0) problems.push('no built files found; run electron-vite build first')
if (problems.length > 0) {
  console.error('The installed desktop app would fail to load these modules:')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('Bundle each one (add it to `exclude` in electron.vite.config.ts) or package it in electron-builder.yml.')
  process.exit(1)
}
console.log(`Packaged-module check passed (${checked} files).`)
