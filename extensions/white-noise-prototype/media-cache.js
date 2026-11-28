// Decrypted attachments live in memory only. Extension storage is capped at 10 MB and
// also holds the group encryption state, so cached files must never go there. The
// files are still on the Blossom servers and can be downloaded and decrypted again.

export const MEDIA_CACHE_BYTES = 48 * 1024 * 1024

export function createMediaCache(limit = MEDIA_CACHE_BYTES) {
  const entries = new Map()
  let total = 0
  const sizeOf = entry => entry?.data?.byteLength ?? 0
  function remove(key) {
    if (!entries.has(key)) return
    total -= sizeOf(entries.get(key))
    entries.delete(key)
  }
  return {
    get size() { return total },
    clear() { entries.clear(); total = 0 },
    // The media store interface Marmot expects for one group.
    storeFor(prefix) {
      const keys = () => [...entries.keys()].filter(key => key.startsWith(`${prefix}:`))
      return {
        async addMedia(id, entry) {
          const key = `${prefix}:${id}`
          remove(key)
          if (sizeOf(entry) > limit) return
          entries.set(key, entry)
          total += sizeOf(entry)
          while (total > limit) remove(entries.keys().next().value)
        },
        async getMedia(id) {
          const key = `${prefix}:${id}`
          const entry = entries.get(key)
          if (!entry) return null
          // Most recently used moves to the back of the queue.
          entries.delete(key)
          entries.set(key, entry)
          return entry
        },
        async removeMedia(id) { remove(`${prefix}:${id}`) },
        async listMedia() { return keys().map(key => entries.get(key).attachment).filter(Boolean) },
        async clearMedia() { for (const key of keys()) remove(key) }
      }
    }
  }
}

// Earlier builds wrote decrypted files into extension storage.
export function legacyMediaKeys(keys) {
  return keys.filter(key => /^marmot:(account:[^:]+:)?media:/.test(key))
}
