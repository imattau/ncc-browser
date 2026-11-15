import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readZip } from '../src/main/extensions/zip'

interface Entry {
  name: string
  data: Buffer
  method?: 0 | 8
}

function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const method = entry.method ?? 8
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const compressed = method === 8 ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

describe('extension zip reader', () => {
  it('reads stored and deflated entries', () => {
    const zip = buildZip([
      { name: 'manifest.json', data: Buffer.from('{"name":"x"}'), method: 0 },
      { name: 'content.js', data: Buffer.from('document.title = "hi"'), method: 8 }
    ])
    const entries = readZip(zip)
    expect(entries.map((entry) => entry.name)).toEqual(['manifest.json', 'content.js'])
    expect(entries[1].data.toString()).toBe('document.title = "hi"')
  })

  it('rejects zip-slip names', () => {
    const zip = buildZip([{ name: '../evil.js', data: Buffer.from('x') }])
    expect(() => readZip(zip)).toThrow(/Unsafe path/)
  })

  it('rejects a truncated archive', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(/ZIP/)
  })
})
