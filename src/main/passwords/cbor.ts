/** Minimal canonical CBOR encoder for WebAuthn's byte-string/map response fields. */
export function encodeCbor(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)])
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([head(3, bytes.length), bytes])
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return head(0, value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value < 0) return head(1, -1 - value)
  if (typeof value === 'boolean') return Buffer.from([value ? 0xf5 : 0xf4])
  if (value === null) return Buffer.from([0xf6])
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)])
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string | number, unknown>)
    return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [encodeCborKey(key), encodeCbor(item)])])
  }
  throw new TypeError('Unsupported CBOR value')
}

function encodeCborKey(key: string): Buffer {
  if (/^(0|[1-9][0-9]*)$/.test(key)) return head(0, Number(key))
  if (/^-[1-9][0-9]*$/.test(key)) return head(1, -Number(key) - 1)
  return encodeCbor(key)
}

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length <= 0xff) return Buffer.from([(major << 5) | 24, length])
  if (length <= 0xffff) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff])
  const out = Buffer.alloc(5)
  out[0] = (major << 5) | 26
  out.writeUInt32BE(length, 1)
  return out
}
