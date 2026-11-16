#!/usr/bin/env node
/**
 * One version, three platforms.
 *
 * The desktop bundles take their version from `package.json` (the release workflow
 * runs `npm version`). Android needs it twice more:
 *
 *   versionName  human-readable, must match `package.json`
 *   versionCode  integer, strictly increasing
 *
 * Zapstore's catalog relay rejects a release whose `versionCode` is equal or lower
 * than the last one it accepted, so the mapping has to be monotonic by construction
 * rather than hand-maintained in Gradle.
 *
 * The formula is Tauri's own (`major * 1_000_000 + minor * 1_000 + patch`) rather
 * than a second scheme: if this script ever stops running, the generated
 * `tauri.properties` still produces the same number, so the sequence never jumps.
 *
 * Usage:
 *   node scripts/android-version.mjs           # write version + versionCode
 *   node scripts/android-version.mjs --check   # fail if anything disagrees
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

let writes = 0

/** @param {string} message */
function fail(message) {
  console.error(`[android-version] ${message}`)
  process.exit(1)
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = String(packageJson.version ?? '')
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
if (!match) fail(`package.json version "${version}" is not plain major.minor.patch`)

const major = Number(match[1])
const minor = Number(match[2])
const patch = Number(match[3])
if (minor > 999 || patch > 999) {
  fail('minor and patch must stay below 1000 so versionCode keeps increasing')
}
const versionCode = major * 1_000_000 + minor * 1_000 + patch
if (versionCode > 2_100_000_000) fail(`versionCode ${versionCode} exceeds the Android limit`)

const confPath = join(root, 'src-tauri', 'tauri.conf.json')
if (!existsSync(confPath)) {
  fail('src-tauri/tauri.conf.json is missing; run `npx tauri init` first')
}

const conf = JSON.parse(readFileSync(confPath, 'utf8'))
const currentVersion = conf.version
const currentCode = conf.bundle?.android?.versionCode

if (currentVersion !== version || currentCode !== versionCode) {
  if (checkOnly) {
    fail(
      `tauri.conf.json has version ${currentVersion} / versionCode ${currentCode}, expected ${version} / ${versionCode}`
    )
  }
  conf.version = version
  conf.bundle ??= {}
  conf.bundle.android ??= {}
  conf.bundle.android.versionCode = versionCode
  writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`)
  writes += 1
}

// Keep the crate version in step, so `cargo build` output is not misleading.
const cratePath = join(root, 'src-tauri', 'Cargo.toml')
if (existsSync(cratePath)) {
  const crate = readFileSync(cratePath, 'utf8')
  const updated = crate.replace(/^version = "[^"]*"$/m, `version = "${version}"`)
  if (updated !== crate) {
    if (checkOnly) fail(`src-tauri/Cargo.toml does not carry version ${version}`)
    writeFileSync(cratePath, updated)
    writes += 1
  }
}

console.log(JSON.stringify({ version, versionCode, changed: checkOnly ? false : currentVersion !== version || currentCode !== versionCode }, null, 2))
