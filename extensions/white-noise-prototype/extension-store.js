/**
 * Chrome extension storage adapter used for Marmot's durable client state.
 * Chrome storage supports JSON-like values, so preserve the richer MLS types
 * explicitly and keep every store under its own namespaced key prefix.
 */
export class ExtensionStore {
  constructor(prefix, storage = chrome.storage.local) {
    this.prefix = `marmot:${prefix}:`
    this.storage = storage
  }

  async getItem(key) {
    const value = (await this.storage.get(this.prefix + key))[this.prefix + key]
    if (value == null) return null
    return restoreStoredValue(value)
  }

  async setItem(key, value) {
    await this.storage.set({ [this.prefix + key]: packStoredValue(value) })
    return value
  }

  async removeItem(key) { await this.storage.remove(this.prefix + key) }
  async clear() { for (const key of await this.keys()) await this.removeItem(key) }
  async keys() { return Object.keys(await this.storage.get(null)).filter(key => key.startsWith(this.prefix)).map(key => key.slice(this.prefix.length)) }
  async entries() { return new Map(Object.entries(await this.storage.get(null)).filter(([key]) => key.startsWith(this.prefix)).map(([key, value]) => [key.slice(this.prefix.length), value])) }
}

export function packStoredValue(value) {
  if (typeof value === 'bigint') return { __nccType: 'bigint', value: value.toString() }
  if (value instanceof Uint8Array) return { __nccType: 'u8', value: bytesToBase64(value) }
  if (value instanceof ArrayBuffer) return { __nccType: 'u8', value: bytesToBase64(new Uint8Array(value)) }
  if (ArrayBuffer.isView(value)) return { __nccType: 'u8', value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
  if (Array.isArray(value)) return value.map(packStoredValue)
  if (value && typeof value === 'object') {
    if (value instanceof Map) return { __nccType: 'map', entries: [...value].map(([key, item]) => [packStoredValue(key), packStoredValue(item)]) }
    if (value instanceof Set) return { __nccType: 'set', values: [...value].map(packStoredValue) }
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = packStoredValue(item)
    return result
  }
  return value
}

export function restoreStoredValue(value) {
  if (Array.isArray(value)) return value.map(restoreStoredValue)
  if (!value || typeof value !== 'object') return value
  if (value.__nccType === 'bigint') return BigInt(value.value)
  if (value.__nccType === 'u8') return base64ToBytes(value.value)
  if (value.__nccType === 'map') return new Map(value.entries.map(([key, item]) => [restoreStoredValue(key), restoreStoredValue(item)]))
  if (value.__nccType === 'set') return new Set(value.values.map(restoreStoredValue))
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = restoreStoredValue(item)
  return result
}

function bytesToBase64(bytes) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function base64ToBytes(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
