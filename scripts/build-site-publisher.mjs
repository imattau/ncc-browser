import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = resolve(root, 'site-publisher')
const output = resolve(app, 'dist-nsite')
const destination = resolve(root, 'resources/site-publisher')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmOptions = { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' }
const npmCli = process.env.npm_execpath
const runNpm = (args) =>
  execFileSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, ...args] : args, npmOptions)

if (!existsSync(resolve(app, 'node_modules'))) {
  runNpm(['ci'])
}
runNpm(['run', 'build'])

rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
cpSync(output, destination, { recursive: true })
