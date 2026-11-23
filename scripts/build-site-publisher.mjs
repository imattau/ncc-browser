import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runNpm } from './npm-runner.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = resolve(root, 'site-publisher')
const output = resolve(app, 'dist-nsite')
const destination = resolve(root, 'resources/site-publisher')

if (!existsSync(resolve(app, 'node_modules'))) {
  runNpm(app, ['ci'])
}
runNpm(app, ['run', 'build'])

rmSync(destination, { recursive: true, force: true })
mkdirSync(destination, { recursive: true })
cpSync(output, destination, { recursive: true })
