/**
 * Reader for the tar inside an .npk. Only regular files, folders and GNU long names
 * are accepted: links and special entries have no place in an extension.
 */

import { zstdDecompressSync } from 'node:zlib'
import { MAX_EXTENSION_BYTES, MAX_EXTENSION_FILES } from '@shared/extensions'
import { isSafeEntry, type ZipEntry } from './zip'

const BLOCK = 512
const MAX_NAME_BYTES = 4096
/** File data plus headers, long names and padding. */
const MAX_TAR_BYTES = MAX_EXTENSION_BYTES + (MAX_EXTENSION_FILES + 16) * BLOCK * 4

export function readNpk(compressed: Buffer): ZipEntry[] {
  let tar: Buffer
  try {
    tar = zstdDecompressSync(compressed, { maxOutputLength: MAX_TAR_BYTES })
  } catch {
    throw new Error('The package is not a zstd archive, or it expands beyond the size limit')
  }
  return readTar(tar)
}

export function readTar(tar: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  let longName: string | null = null
  let total = 0
  let count = 0
  let offset = 0

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    if (checksum(header) !== octal(header, 148, 8)) throw new Error('The package archive is damaged')

    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48)
    const start = offset + BLOCK
    if (start + size > tar.length) throw new Error('The package archive is truncated')
    const data = tar.subarray(start, start + size)
    offset = start + Math.ceil(size / BLOCK) * BLOCK

    count += 1
    if (count > MAX_EXTENSION_FILES * 3) throw new Error('The package contains too many files')

    if (type === 'L') {
      if (size > MAX_NAME_BYTES) throw new Error('The package has an overlong file name')
      longName = text(data)
      continue
    }
    const prefix = header.subarray(257, 263).equals(Buffer.from('ustar\0'))
      ? text(header.subarray(345, 500))
      : ''
    const short = text(header.subarray(0, 100))
    const name: string = longName ?? (prefix ? `${prefix}/${short}` : short)
    longName = null

    if (type === '5') continue
    if (type !== '0') throw new Error(`The package contains a link or special file: ${name}`)
    if (!isSafeEntry(name)) throw new Error(`Unsafe path in package: ${name}`)
    if (seen.has(name)) throw new Error(`The package repeats a file: ${name}`)
    seen.add(name)
    total += size
    if (total > MAX_EXTENSION_BYTES) throw new Error('The package expands beyond the size limit')
    if (seen.size > MAX_EXTENSION_FILES) throw new Error('The package contains too many files')
    entries.push({ name, data: Buffer.from(data) })
  }
  if (entries.length === 0) throw new Error('The package is empty')
  return entries
}

function text(bytes: Buffer): string {
  const end = bytes.indexOf(0)
  return bytes.toString('utf8', 0, end < 0 ? bytes.length : end)
}

function octal(header: Buffer, start: number, length: number): number {
  const value = text(header.subarray(start, start + length)).trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('The package archive has an invalid header')
  return parseInt(value, 8)
}

/** The sum of the header bytes with the checksum field read as spaces. */
function checksum(header: Buffer): number {
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index]
  }
  return sum
}
