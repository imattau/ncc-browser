import { copyFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = import.meta.dirname
const output = resolve(root, '.bundle-build/marmot.bundle.js')
copyFileSync(output, resolve(root, 'marmot.bundle.js'))
rmSync(resolve(root, '.bundle-build'), { recursive: true, force: true })
