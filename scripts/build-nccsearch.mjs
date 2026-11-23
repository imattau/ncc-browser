import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNpm } from './npm-runner.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ui = resolve(root, 'vendor/ncc-server/ncc-search/ui')
const output = resolve(ui, 'dist-nsite')

runNpm(ui, ['ci'])
runNpm(ui, ['run', 'build:nsite'])
const version = execFileSync('git', ['-C', resolve(root, 'vendor/ncc-server'), 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
writeFileSync(resolve(output, 'version.txt'), `${version}\n`)

for (const destination of [resolve(root, 'resources/nccsearch'), resolve(root, 'mobile/public/nccsearch')]) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(output, destination, { recursive: true })
}
