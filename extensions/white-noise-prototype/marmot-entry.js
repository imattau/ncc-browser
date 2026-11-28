import { MarmotClient, createApplicationMessageIntent, createChatRumor } from '@internet-privacy/marmot-ts'
import { makeKeyValueRumorHistoryFactory } from '@internet-privacy/marmot-ts/extra'
import { deserializeApplicationData, getInboxRelays } from '@internet-privacy/marmot-ts/core'
import { Proposals } from '@internet-privacy/marmot-ts/client'
import { nip19 } from 'nostr-tools'

class ExtensionStore {
  constructor(prefix) { this.prefix = `marmot:${prefix}:` }
  async getItem(key) {
    const value = (await chrome.storage.local.get(this.prefix + key))[this.prefix + key]
    if (value == null) return null
    return restore(value)
  }
  async setItem(key, value) {
    await chrome.storage.local.set({ [this.prefix + key]: pack(value) })
    return value
  }
  async removeItem(key) { await chrome.storage.local.remove(this.prefix + key) }
  async clear() { for (const key of await this.keys()) await this.removeItem(key) }
  async keys() { return Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith(this.prefix)).map(key => key.slice(this.prefix.length)) }
}

function pack(value) {
  if (typeof value === 'bigint') return { __nccType: 'bigint', value: value.toString() }
  if (value instanceof Uint8Array) return { __nccType: 'u8', value: bytesToBase64(value) }
  if (value instanceof ArrayBuffer) return { __nccType: 'u8', value: bytesToBase64(new Uint8Array(value)) }
  if (ArrayBuffer.isView(value)) return { __nccType: 'u8', value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
  if (Array.isArray(value)) return value.map(pack)
  if (value && typeof value === 'object') {
    if (value instanceof Map) return { __nccType: 'map', entries: [...value].map(([key, item]) => [pack(key), pack(item)]) }
    if (value instanceof Set) return { __nccType: 'set', values: [...value].map(pack) }
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = pack(item)
    return result
  }
  return value
}

function restore(value) {
  if (Array.isArray(value)) return value.map(restore)
  if (!value || typeof value !== 'object') return value
  if (value.__nccType === 'bigint') return BigInt(value.value)
  if (value.__nccType === 'u8') return base64ToBytes(value.value)
  if (value.__nccType === 'map') return new Map(value.entries.map(([key, item]) => [restore(key), restore(item)]))
  if (value.__nccType === 'set') return new Set(value.values.map(restore))
  const result = {}
  for (const [key, item] of Object.entries(value)) result[key] = restore(item)
  return result
}

function bytesToBase64(bytes) { let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary) }
function base64ToBytes(value) { const binary = atob(value); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index); return bytes }

function relayUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'wss:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid relay URL: ${value}`)
  return url.toString().replace(/\/$/, '')
}

let relayConfig = []

function relayRequest(url, filters) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const events = new Map()
    const subId = crypto.randomUUID().replaceAll('-', '')
    let done = false
    const timer = setTimeout(() => finish(new Error(`Relay request timed out: ${url}`)), 12000)
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subId])); socket.close() } catch {}
      error ? reject(error) : resolve(value)
    }
    socket.onopen = () => socket.send(JSON.stringify(['REQ', subId, ...filters]))
    socket.onerror = () => finish(new Error(`Relay connection failed: ${url}`))
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data)
        if (message[0] === 'EVENT' && message[1] === subId) events.set(message[2].id, message[2])
        if (message[0] === 'EOSE' && message[1] === subId) finish(null, [...events.values()])
        if (message[0] === 'CLOSED' && message[1] === subId) finish(new Error(`Relay refused request: ${message[2] || url}`))
      } catch (error) { finish(error) }
    }
  })
}

const network = {
  async publish(relays, event) {
    const responses = await ncc.nostr.publishEvent(relays, event)
    // NCC returns URL.toString() keys with a trailing slash. Marmot's retained
    // commit retry compares response keys to its canonical relay list without a
    // slash, so preserve the exact normalized relay identity in the result map.
    return Object.fromEntries(Object.entries(responses).map(([relay, response]) => {
      const normalized = relayUrl(relay)
      return [normalized, { ...response, from: normalized }]
    }))
  },
  async request(relays, filters) {
    return ncc.nostr.requestEvents(relays, Array.isArray(filters) ? filters : [filters])
  },
  subscription(relays, filters) {
    let active = true
    return { subscribe(observer) {
      const known = new Set()
      const filterList = Array.isArray(filters) ? filters : [filters]
      const poll = async () => {
        if (!active) return
        try {
          const events = await network.request(relays, filterList)
          if (!active) return
          for (const event of events) if (!known.has(event.id)) { known.add(event.id); observer.next?.(event) }
        } catch (error) { if (active) observer.error?.(error) }
      }
      void poll()
      const timer = setInterval(() => void poll(), 8000)
      return { unsubscribe() { active = false; clearInterval(timer) } }
    } }
  },
  async getUserInboxRelays(pubkey) {
    const events = await this.request(relayConfig, [{ kinds: [10050], authors: [pubkey], limit: 1 }])
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
    return latest ? getInboxRelays(latest) : relayConfig
  }
}

const api = {
  async connect(relays) {
    relayConfig = relays
    // Chromium extension contexts do not expose crypto.randomUUID() on all supported builds.
    if (!crypto.randomUUID) crypto.randomUUID = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('')
    const signer = {
      getPublicKey: () => ncc.nostr.getPublicKey(),
      signEvent: event => ncc.nostr.signEvent(event),
      nip44: {
        encrypt: (peer, plaintext) => ncc.nostr.nip44.encrypt(peer, plaintext),
        decrypt: (peer, ciphertext) => ncc.nostr.nip44.decrypt(peer, ciphertext)
      }
    }
    const clientIdKey = 'marmot:clientId'
    let clientId = (await chrome.storage.local.get(clientIdKey))[clientIdKey]
    if (!clientId) { clientId = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''); await chrome.storage.local.set({ [clientIdKey]: clientId }) }
    const keyStore = new ExtensionStore('keypackages')
    const client = new MarmotClient({ signer, network, groupStateStore: new ExtensionStore('groups'), keyPackageStore: keyStore, clientId, historyFactory: makeKeyValueRumorHistoryFactory(groupId => new ExtensionStore(`history:${[...groupId].map(byte => byte.toString(16).padStart(2, '0')).join('')}`)), getSignatureKeyPair: async ciphersuite => {
      const saved = await keyStore.getItem('local-signature-key')
      if (saved?.signKey && saved?.publicKey) return { signKey: saved.signKey, publicKey: saved.publicKey }
      const pair = await ciphersuite.signature.keygen()
      await keyStore.setItem('local-signature-key', pair)
      return pair
    }, inviteStore: new ExtensionStore('invites'), ingestStateStore: new ExtensionStore('ingest') })
    await client.groups.loadAll()
    const live = client.groups.connectAll({ fallbackRelays: relays })
    return { client, live, pubkey: await signer.getPublicKey() }
  },
  // This is an explicit user action. ensurePublished() may reuse an old local
  // package without publishing it to the currently selected relays. Create a
  // fresh slot occupant instead; prior private packages stay available for any
  // delayed Welcome addressed to them.
  createKeyPackage(client, relays) { return client.keyPackages.create({ relays }) },
  async createGroup(client, relays, name) {
    await client.keyPackages.ensurePublished({ relays })
    const group = await client.groups.create(name, { description: '', relays, adminPubkeys: [await client.signer.getPublicKey()] })
    const sender = await client.signer.getPublicKey()
    const rumor = createChatRumor({ pubkey: sender, content: 'This is a private note to self.' })
    await client.groups.send(group.snapshot.id, createApplicationMessageIntent(rumor))
    await group.history.saveRumor(rumor)
    return group
  },
  async updateGroupRelays(client, groupId, relays) {
    const group = await client.groups.get(groupId)
    await group.propose(Proposals.proposeUpdateMetadata({ relays }))
    return client.groups.commit(groupId)
  },
  async listGroups(client) { return client.groups.loadAll() },
  async history(group) { return group.history.queryRumors({ limit: 200 }) },
  async send(client, groupId, text) {
    const pubkey = await client.signer.getPublicKey()
    const rumor = createChatRumor({ pubkey, content: text })
    await client.groups.send(groupId, createApplicationMessageIntent(rumor))
    return rumor
  },
  async inviteContact(client, groupId, address, relays) {
    let pubkey = address.trim()
    if (pubkey.startsWith('npub1')) {
      const decoded = nip19.decode(pubkey)
      if (decoded.type !== 'npub') throw new Error('Enter a public npub address.')
      pubkey = decoded.data
    }
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error('Enter a valid npub or 64-character public key.')
    const keyPackages = await client.network.request(relays, [{ kinds: [30443], authors: [pubkey.toLowerCase()], limit: 10 }])
    const keyPackage = keyPackages.sort((left, right) => right.created_at - left.created_at)[0]
    if (!keyPackage) throw new Error('No invite key package found. Ask this contact to connect and publish one first.')
    try {
      return await client.groups.invite(groupId, keyPackage)
    } catch (error) {
      if (error instanceof Error && error.message.includes('leaf carries no app_data_dictionary extension')) {
        throw new Error('This White Noise profile’s key package predates the account identity proof required by this Marmot v2 group. Update White Noise to a compatible release, then publish a fresh key package.')
      }
      if (error instanceof Error && error.message.includes('KeyPackage lifetime exceeds cap or is not current')) {
        throw new Error('The contact’s newest invite key is expired or not yet valid. Ask them to publish a new key package, then try again.')
      }
      throw error
    }
  },
  decode: deserializeApplicationData
}
window.MarmotCompanion = api
