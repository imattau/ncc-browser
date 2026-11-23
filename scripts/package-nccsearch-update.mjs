import { createHash, sign } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const root = process.cwd()
const source = join(root, 'resources/nccsearch')
const output = join(root, 'release/nccsearch-update')
const key = process.env.NCCSEARCH_UPDATE_SIGNING_KEY_PEM
if (!key) throw new Error('Set the NCCSEARCH_UPDATE_SIGNING_KEY_PEM repository secret to sign nccsearch updates')
const version = readFileSync(join(source, 'version.txt'), 'utf8').trim()
if (!/^[a-f0-9]{7,40}$/.test(version)) throw new Error('The embedded nccsearch version is invalid')
const releaseTag = process.env.GITHUB_REF_NAME
if (!releaseTag || !/^v[\d.]+(?:-[\w.]+)?$/.test(releaseTag)) throw new Error('Run this from a version release')

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const files = []
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) walk(absolute)
    else if (entry.isFile()) {
      const path = relative(source, absolute).split(sep).join('/')
      const asset = `nccsearch-file-${path.replaceAll('/', '__')}`
      const bytes = readFileSync(absolute)
      files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), asset })
      cpSync(absolute, join(output, asset))
    }
  }
}
walk(source)
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const payload = [version, releaseTag, ...files.map(({ path, sha256 }) => `${path}\t${sha256}`)].join('\n')
const manifest = { version, releaseTag, files, signature: sign(null, Buffer.from(payload), key).toString('base64') }
const manifestPath = join(output, 'nccsearch-manifest.json')
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
for (const filename of readdirSync(output)) cpSync(join(output, filename), join(root, 'release', filename))
