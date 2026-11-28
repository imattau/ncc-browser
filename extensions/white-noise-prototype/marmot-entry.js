import { MarmotClient, createApplicationMessageIntent, createChatRumor } from '@internet-privacy/marmot-ts'
import { makeKeyValueRumorHistoryFactory } from '@internet-privacy/marmot-ts/extra'
import { createInboxRelayListEvent, deserializeApplicationData, encryptedMediaBlossomDefaultV2, getInboxRelays, getMediaAttachments } from '@internet-privacy/marmot-ts/core'
import { createBlossomMediaTransport, createInviteIntent, downloadMessageMedia, prepareMediaMessage, Proposals } from '@internet-privacy/marmot-ts/client'
import { nip19, verifyEvent } from 'nostr-tools'

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

function sameRelayList(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every(relay => right.includes(relay))
}

// Keep the companion's general-purpose relay defaults primary. White Noise's
// hosted relays are added by the panel as Marmot group connection fallbacks.
const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.ditto.pub']
let relayConfig = DEFAULT_RELAYS
let lastKeyPackagePublication = null
let activeSignerPubkey = null
const DEFAULT_BLOSSOM_SERVERS = ['https://blossom.primal.net']
const MEDIA_MAX_BYTES = 25 * 1024 * 1024

async function publishWithNip42(relay, event) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relay)
    let authEventId = null
    let eventSent = false
    let settled = false
    const timer = setTimeout(() => finish(new Error(`Relay publish timed out: ${relay}`)), 12000)
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch {}
      error ? reject(error) : resolve(result)
    }
    const sendEvent = () => {
      if (eventSent || socket.readyState !== WebSocket.OPEN) return
      eventSent = true
      socket.send(JSON.stringify(['EVENT', event]))
    }
    socket.onopen = sendEvent
    socket.onerror = () => finish(new Error(`Relay connection failed: ${relay}`))
    socket.onclose = () => { if (!settled) finish(new Error(`Relay closed the connection: ${relay}`)) }
    socket.onmessage = async message => {
      let frame
      try { frame = JSON.parse(message.data) } catch { return }
      if (frame[0] === 'AUTH') {
        try {
          const now = Math.floor(Date.now() / 1000)
          const signed = await ncc.nostr.signEvent({ kind: 22242, created_at: now, tags: [['relay', relay], ['challenge', frame[1]], ['expiration', String(now + 600)]], content: '' })
          if (!verifyEvent(signed) || signed.pubkey !== activeSignerPubkey) throw new Error('The active NCC profile changed during relay authentication.')
          authEventId = signed.id
          eventSent = false
          socket.send(JSON.stringify(['AUTH', signed]))
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      } else if (frame[0] === 'OK' && frame[1] === authEventId) {
        if (frame[2]) sendEvent()
        else finish(new Error(`Relay AUTH rejected: ${frame[3] || relay}`))
      } else if (frame[0] === 'OK' && frame[1] === event.id) {
        if (frame[2]) finish(null, { from: relay, ok: true, message: frame[3] || 'accepted' })
        else finish(new Error(`Relay rejected the event: ${frame[3] || relay}`))
      } else if (frame[0] === 'NOTICE') finish(new Error(`Relay notice: ${frame[1]}`))
    }
  })
}

function relayRequest(url, filters) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const events = new Map()
    const subId = crypto.randomUUID().replaceAll('-', '')
    let requestSent = false
    let authEventId = null
    let done = false
    const timer = setTimeout(() => finish(new Error(`Relay request timed out: ${url}`)), 12000)
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subId])); socket.close() } catch {}
      error ? reject(error) : resolve(value)
    }
    const sendRequest = () => {
      if (requestSent || socket.readyState !== WebSocket.OPEN) return
      requestSent = true
      socket.send(JSON.stringify(['REQ', subId, ...filters]))
    }
    socket.onopen = sendRequest
    socket.onerror = () => finish(new Error(`Relay connection failed: ${url}`))
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data)
        if (message[0] === 'AUTH') {
          void (async () => {
            try {
              const now = Math.floor(Date.now() / 1000)
              const signed = await ncc.nostr.signEvent({ kind: 22242, created_at: now, tags: [['relay', url], ['challenge', message[1]], ['expiration', String(now + 600)]], content: '' })
              if (!verifyEvent(signed) || signed.pubkey !== activeSignerPubkey) throw new Error('The active NCC profile changed during relay authentication.')
              authEventId = signed.id
              requestSent = false
              socket.send(JSON.stringify(['AUTH', signed]))
            } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
          })()
          return
        }
        if (message[0] === 'OK' && message[1] === authEventId) {
          if (message[2]) sendRequest()
          else finish(new Error(`Relay AUTH rejected: ${message[3] || url}`))
          return
        }
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
    const normalized = Object.fromEntries(Object.entries(responses).map(([relay, response]) => {
      const normalized = relayUrl(relay)
      return [normalized, { ...response, from: normalized }]
    }))
    const retry = Object.entries(normalized).filter(([, response]) => !response.ok)
    const retried = await Promise.all(retry.map(async ([relay, original]) => {
      try { return [relay, await publishWithNip42(relay, event)] }
      catch (error) { return [relay, { ...original, message: `${original.message || 'publish failed'}; authenticated retry failed: ${error instanceof Error ? error.message : String(error)}` }] }
    }))
    for (const [relay, response] of retried) normalized[relay] = response
    if (event.kind === 30443) lastKeyPackagePublication = { eventId: event.id, responses: normalized }
    return normalized
  },
  async request(relays, filters) {
    const filterList = Array.isArray(filters) ? filters : [filters]
    const results = await Promise.allSettled(relays.map(relay => relayRequest(relay, filterList)))
    const successful = results.filter(result => result.status === 'fulfilled')
    if (!successful.length) throw results.find(result => result.status === 'rejected')?.reason || new Error('No relay answered the request.')
    return [...new Map(successful.flatMap(result => result.value).map(event => [event.id, event])).values()]
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
    return latest ? getInboxRelays(latest) : DEFAULT_RELAYS
  }
}

const api = {
  async connect(relays, expectedPubkey, fallbackRelays = relays) {
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
    const pubkey = await signer.getPublicKey()
    activeSignerPubkey = pubkey
    if (expectedPubkey && pubkey !== expectedPubkey) throw new Error('The active NCC account has changed. Select the previous account to reopen its chats.')
    const accountPrefix = `account:${pubkey}:`
    await migrateLegacyAccountData(pubkey, accountPrefix)
    const blossomServers = await resolveBlossomServers(pubkey, relays)
    const clientIdKey = `marmot:${accountPrefix}clientId`
    let clientId = (await chrome.storage.local.get(clientIdKey))[clientIdKey]
    if (!clientId) { clientId = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join(''); await chrome.storage.local.set({ [clientIdKey]: clientId }) }
    const keyStore = new ExtensionStore(`${accountPrefix}keypackages`)
    const client = new MarmotClient({ signer, network, groupStateStore: new ExtensionStore(`${accountPrefix}groups`), rewindStore: new ExtensionStore(`${accountPrefix}rewind`), keyPackageStore: keyStore, clientId, historyFactory: makeKeyValueRumorHistoryFactory(groupId => new ExtensionStore(`${accountPrefix}history:${[...groupId].map(byte => byte.toString(16).padStart(2, '0')).join('')}`)), mediaFactory: groupId => createMediaStore(`${accountPrefix}media:${[...groupId].map(byte => byte.toString(16).padStart(2, '0')).join('')}`), getSignatureKeyPair: async ciphersuite => {
      const saved = await keyStore.getItem('local-signature-key')
      if (saved?.signKey && saved?.publicKey) return { signKey: saved.signKey, publicKey: saved.publicKey }
      const pair = await ciphersuite.signature.keygen()
      await keyStore.setItem('local-signature-key', pair)
      return pair
    }, inviteStore: new ExtensionStore(`${accountPrefix}invites`), ingestStateStore: new ExtensionStore(`${accountPrefix}ingest`) })
    await client.groups.loadAll()
    const live = client.groups.connectAll({ fallbackRelays })
    const inviteListener = await client.invites.listen(relays)
    const mediaTransport = createBlossomMediaTransport({ signer })
    return { client, live, inviteListener, pubkey, blossomServers, mediaTransport, fallbackRelays }
  },
  // This is an explicit user action. ensurePublished() may reuse an old local
  // package without publishing it to the currently selected relays. Create a
  // fresh slot occupant instead; prior private packages stay available for any
  // delayed Welcome addressed to them.
  async createKeyPackage(client, relays) {
    lastKeyPackagePublication = null
    const inboxKey = `marmot:account:${await client.signer.getPublicKey()}:inboxRelays`
    const savedInbox = (await chrome.storage.local.get(inboxKey))[inboxKey] || {}
    let inboxPublication = savedInbox.publication || null
    if (!sameRelayList(savedInbox.relays, relays)) {
      const event = createInboxRelayListEvent({ pubkey: await client.signer.getPublicKey(), relays })
      event.created_at = Math.max(event.created_at, Number(savedInbox.createdAt || 0) + 1)
      const signed = await client.signer.signEvent(event)
      if (!verifyEvent(signed) || signed.pubkey !== await client.signer.getPublicKey()) throw new Error('The signed inbox relay list did not match the active NCC profile.')
      const responses = await client.network.publish(relays, signed)
      const accepted = Object.values(responses).some(response => response.ok)
      if (!accepted) throw new Error('No relay acknowledged the inbox relay list. Check the selected relays and retry.')
      inboxPublication = responses
      await chrome.storage.local.set({ [inboxKey]: { relays: [...relays], createdAt: signed.created_at, publication: responses } })
    }
    const keyPackage = await client.keyPackages.create({ relays })
    return { keyPackage, publication: lastKeyPackagePublication, inboxPublication }
  },
  async getInvites(client) {
    const invites = await client.invites.getUnread()
    return Promise.all(invites.map(async rumor => ({
      rumor,
      preview: await client.previewWelcome(rumor),
      canJoin: await client.canJoinInvite(rumor)
    })))
  },
  async joinInvite(client, rumor) {
    const result = await client.joinGroupFromWelcome({ welcomeRumor: rumor })
    await client.invites.markAsRead(rumor.id)
    return result.group
  },
  async dismissInvite(client, rumor) {
    await client.invites.markAsRead(rumor.id)
  },
  async createGroup(client, relays, name) {
    await client.keyPackages.ensurePublished({ relays })
    const servers = await resolveBlossomServers(await client.signer.getPublicKey(), relays)
    const group = await client.groups.create(name, { description: '', relays, adminPubkeys: [await client.signer.getPublicKey()], encryptedMedia: encryptedMediaBlossomDefaultV2(servers) })
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
  async renameGroup(client, groupId, name) {
    const group = await client.groups.get(groupId)
    await group.propose(Proposals.proposeUpdateMetadata({ name }))
    return client.groups.commit(groupId)
  },
  async removeGroupMember(client, groupId, memberPubkey) {
    const group = await client.groups.get(groupId)
    const ownPubkey = await client.signer.getPublicKey()
    if (!(group.snapshot.groupData?.adminPubkeys || []).includes(ownPubkey)) {
      throw new Error('Only a group admin can remove members.')
    }
    if (memberPubkey === ownPubkey || !(group.snapshot.members || []).includes(memberPubkey)) {
      throw new Error('Choose another current member of this group.')
    }
    await group.propose(Proposals.proposeRemoveUser(memberPubkey))
    await client.groups.commit(groupId)
    const updated = await client.groups.get(groupId)
    if ((updated.snapshot.members || []).includes(memberPubkey)) {
      throw new Error('The removal was not applied. The member is still in the group.')
    }
    return updated
  },
  async enableGroupMedia(client, groupId, servers) {
    const group = await client.groups.get(groupId)
    const ownPubkey = await client.signer.getPublicKey()
    if (!(group.snapshot.groupData?.adminPubkeys || []).includes(ownPubkey)) throw new Error('Only a group admin can enable encrypted media.')
    await group.propose(Proposals.proposeSetEncryptedMediaPolicy(encryptedMediaBlossomDefaultV2(normalizeBlossomServers(servers)), true))
    await client.groups.commit(groupId)
    return client.groups.get(groupId)
  },
  async transferAdminAndLeave(client, groupId, successorPubkey) {
    const group = await client.groups.get(groupId)
    const ownPubkey = await client.signer.getPublicKey()
    const currentAdmins = group.snapshot.groupData?.adminPubkeys || []
    const members = group.snapshot.members || []
    if (!members.includes(successorPubkey) || successorPubkey === ownPubkey) {
      throw new Error('Choose another existing group member as the new admin.')
    }
    if (!currentAdmins.includes(ownPubkey)) throw new Error('You are no longer an admin of this group.')
    const nextAdmins = [...new Set([...currentAdmins.filter(pubkey => pubkey !== ownPubkey), successorPubkey])]
    if (!nextAdmins.length) throw new Error('The group must keep at least one admin.')
    await group.propose(Proposals.proposeUpdateMetadata({ adminPubkeys: nextAdmins }))
    await client.groups.commit(groupId)
    const updated = await client.groups.get(groupId)
    if (!updated.snapshot.groupData?.adminPubkeys?.includes(successorPubkey)) {
      throw new Error('Admin transfer was not applied. The group was not left.')
    }
    return client.groups.leave(groupId)
  },
  leaveGroup(client, groupId) { return client.groups.leave(groupId) },
  async listGroups(client) { return client.groups.loadAll() },
  async history(group) { return group.history.queryRumors({ limit: 200 }) },
  async send(client, groupId, text) {
    const pubkey = await client.signer.getPublicKey()
    const rumor = createChatRumor({ pubkey, content: text })
    await client.groups.send(groupId, createApplicationMessageIntent(rumor))
    return rumor
  },
  async sendMedia(client, groupId, files, caption, transport) {
    const group = await client.groups.get(groupId)
    const prepared = await prepareMediaMessage(group, files, { transport, maxBytes: MEDIA_MAX_BYTES, caption })
    await client.groups.send(groupId, prepared.intent)
    await group.history.saveRumor(prepared.rumor)
    return prepared.rumor
  },
  async downloadMedia(client, groupId, rumor, transport) {
    const group = await client.groups.get(groupId)
    const attachments = getMediaAttachments(rumor.tags || [])
    if (!attachments.length) return []
    const sourceParent = await group.session.mediaSourceForRumor(rumor.id)
    if (!sourceParent) throw new Error('The media encryption epoch for this message is unavailable on this device.')
    return downloadMessageMedia(group, rumor.tags, sourceParent, { transport, maxBytes: MEDIA_MAX_BYTES })
  },
  mediaAttachments(rumor) { return getMediaAttachments(rumor.tags || []) },
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
      const intent = createInviteIntent({
        keyPackageEvent: keyPackage,
        actorPubkey: await client.signer.getPublicKey(),
        verifyEvent
      })
      const [result] = await client.groups.send(groupId, intent)
      return result.welcomeDelivery
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

function normalizeBlossomServers(values) {
  const servers = [...new Set((Array.isArray(values) ? values : []).map(value => {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid Blossom server URL: ${value}`)
    return url.origin
  }))].slice(0, 8)
  if (!servers.length) throw new Error('Add at least one HTTPS Blossom server before enabling encrypted media.')
  return servers
}

async function resolveBlossomServers(pubkey, relays) {
  try {
    const events = await network.request(relays, [{ kinds: [10063], authors: [pubkey], limit: 10 }])
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
    const servers = normalizeBlossomServers((latest?.tags || []).filter(tag => tag[0] === 'server').map(tag => tag[1]).filter(Boolean))
    if (servers.length) return servers
  } catch (error) { console.warn('[white-noise] Blossom server-list lookup failed; using the public default:', error) }
  return DEFAULT_BLOSSOM_SERVERS
}

function createMediaStore(prefix) {
  const store = new ExtensionStore(prefix)
  return {
    addMedia: (key, value) => store.setItem(key, value),
    getMedia: key => store.getItem(key),
    removeMedia: key => store.removeItem(key),
    async listMedia() { return Promise.all((await store.keys()).map(key => store.getItem(key))).then(entries => entries.filter(entry => entry?.attachment).map(entry => entry.attachment)) },
    clearMedia: () => store.clear()
  }
}

async function migrateLegacyAccountData(pubkey, accountPrefix) {
  const marker = `marmot:account-migrated:${pubkey}`
  if ((await chrome.storage.local.get(marker))[marker]) return
  const { connectedSignerPubkey } = await chrome.storage.local.get('connectedSignerPubkey')
  if (connectedSignerPubkey && connectedSignerPubkey !== pubkey) return
  const legacyPrefixes = ['groups', 'keypackages', 'invites', 'ingest', 'history:']
  const all = await chrome.storage.local.get(null)
  const migrated = {}
  for (const [key, value] of Object.entries(all)) {
    const prefix = legacyPrefixes.find(item => key.startsWith(`marmot:${item}`))
    if (!prefix) continue
    const suffix = key.slice(`marmot:${prefix}`.length)
    migrated[`marmot:${accountPrefix}${prefix}${suffix}`] = value
  }
  if (all['marmot:clientId']) migrated[`marmot:${accountPrefix}clientId`] = all['marmot:clientId']
  if (Object.keys(migrated).length) await chrome.storage.local.set(migrated)
  await chrome.storage.local.set({ [marker]: true })
}
window.MarmotCompanion = api
