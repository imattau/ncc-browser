import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ui = resolve(root, 'vendor/ncc-server/ncc-search/ui')
const output = resolve(ui, 'dist-nsite')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmOptions = { cwd: ui, stdio: 'inherit', shell: process.platform === 'win32' }
const npmCli = process.env.npm_execpath
const runNpm = (args) => execFileSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, ...args] : args, npmOptions)
runNpm(['ci'])
runNpm(['run', 'build:nsite'])

for (const destination of [resolve(root, 'resources/nccsearch'), resolve(root, 'mobile/public/nccsearch')]) {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(output, destination, { recursive: true })
}
