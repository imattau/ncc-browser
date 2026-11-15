/**
 * Minimal ZIP reader for extension packages. Supports stored and deflated entries,
 * rejects zip-slip paths and bounds the extracted size. No external dependency, so
 * the installer works on Linux, macOS and Windows.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { MAX_EXTENSION_BYTES, MAX_EXTENSION_FILES } from '@shared/extensions'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export interface ZipEntry {
  name: string
  data: Buffer
}

export function readZip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw new Error('That file is not a ZIP package')
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('That file is not a ZIP package')

  const total = buffer.readUInt16LE(eocd + 10)
  const size = buffer.readUInt32LE(eocd + 12)
  const offset = buffer.readUInt32LE(eocd + 16)
  if (total > MAX_EXTENSION_FILES) throw new Error('The package contains too many files')
  if (size > MAX_EXTENSION_BYTES * 2) throw new Error('The package is too large')
  if (offset + size > buffer.length) throw new Error('The ZIP central directory is truncated')

  const entries: ZipEntry[] = []
  let cursor = offset
  let extracted = 0
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length) throw new Error('The ZIP central directory is truncated')
    if (buffer.readUInt32LE(cursor) !== CENTRAL) throw new Error('Invalid ZIP directory entry')
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (!isSafeEntry(name)) throw new Error(`Unsafe path in package: ${name}`)
    if (uncompressedSize > MAX_EXTENSION_BYTES) throw new Error(`File is too large: ${name}`)
    extracted += uncompressedSize
    if (extracted > MAX_EXTENSION_BYTES) throw new Error('The package expands beyond the size limit')

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`Invalid ZIP entry: ${name}`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new Error(`Truncated ZIP entry: ${name}`)
    const raw = buffer.subarray(dataStart, dataEnd)

    let data: Buffer
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      data = inflateRawSync(raw)
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`)
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`ZIP entry size mismatch: ${name}`)
    }
    entries.push({ name, data })
  }
  if (entries.length === 0) throw new Error('The package is empty')
  return entries
}

export function extractZip(buffer: Buffer, destination: string): void {
  const root = resolve(destination)
  for (const entry of readZip(buffer)) {
    const target = resolve(join(root, entry.name))
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`Unsafe path in package: ${entry.name}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === EOCD) return index
  }
  return -1
}

function isSafeEntry(name: string): boolean {
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name)) return false
  if (name.includes('\u0000')) return false
  return !name.split('/').some((part) => part === '..' || part === '.' || part === '')
}
