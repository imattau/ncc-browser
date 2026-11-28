// Live relay subscriptions over one open connection per relay. New events are pushed
// by the relay, so nothing is re-requested while the connection stays up. After a
// drop, each subscription asks only for what it may have missed.

const PROBE = 'ncc-ping'
const CONNECT_TIMEOUT = 12_000
const PROBE_TIMEOUT = 10_000
const HEARTBEAT = 60_000
const MAX_RETRY = 60_000
// A refused sign-in must not turn into a stream of signing requests.
const AUTH_RETRY = 5 * 60_000
// NIP-59 backdates gift wraps by up to two days.
const GIFT_WRAP = 1059
const GIFT_WRAP_OVERLAP = 3 * 24 * 3600
const OVERLAP = 3600

export function resumeFilters(filters, aliveAt) {
  if (aliveAt === null) return filters
  return filters.map(filter => {
    const overlap = !filter.kinds || filter.kinds.includes(GIFT_WRAP) ? GIFT_WRAP_OVERLAP : OVERLAP
    return { ...filter, since: Math.max(filter.since ?? 0, Math.floor(aliveAt / 1000) - overlap) }
  })
}

export function createLiveRelays({ signAuth, createSocket = url => new WebSocket(url), now = () => Date.now() }) {
  const relays = new Map()
  let nextId = 0

  function relayFor(url) {
    let relay = relays.get(url)
    if (!relay) {
      relay = { url, socket: null, subs: new Map(), attempts: 0, retry: null, timers: new Set(), authId: null, authed: false, heardAt: 0 }
      relays.set(url, relay)
    }
    return relay
  }

  const send = (relay, frame) => {
    if (relay.socket?.readyState === 1) relay.socket.send(JSON.stringify(frame))
  }

  function request(relay, id) {
    const sub = relay.subs.get(id)
    if (!sub) return
    clearTimeout(sub.retry)
    sub.retry = null
    send(relay, ['REQ', id, ...resumeFilters(sub.filters, sub.aliveAt)])
  }

  function later(relay, run, ms) {
    const timer = setTimeout(() => { relay.timers.delete(timer); run() }, ms)
    relay.timers.add(timer)
    return timer
  }

  function clearTimers(relay) {
    for (const timer of relay.timers) clearTimeout(timer)
    relay.timers.clear()
    clearTimeout(relay.retry)
    relay.retry = null
    for (const sub of relay.subs.values()) { clearTimeout(sub.retry); sub.retry = null }
  }

  // Closes the socket without letting its late callbacks affect a newer one.
  function detach(relay) {
    clearTimers(relay)
    const socket = relay.socket
    relay.socket = null
    relay.authId = null
    relay.authed = false
    if (!socket) return
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    try { socket.close() } catch {}
  }

  function drop(relay, reason, wait) {
    detach(relay)
    if (!relay.subs.size) return
    for (const sub of relay.subs.values()) sub.onError(new Error(`${reason}: ${relay.url}`))
    const delay = wait ?? Math.min(MAX_RETRY, 1000 * 2 ** relay.attempts)
    relay.attempts += 1
    relay.retry = setTimeout(() => { relay.retry = null; open(relay) }, delay)
  }

  // A half-open connection looks healthy but delivers nothing, so ask for a reply.
  function heartbeat(relay) {
    later(relay, () => {
      if (now() - relay.heardAt >= HEARTBEAT) {
        const asked = now()
        send(relay, ['REQ', PROBE, { ids: ['0'.repeat(64)], limit: 1 }])
        later(relay, () => { if (relay.heardAt < asked) drop(relay, 'Relay stopped responding') }, PROBE_TIMEOUT)
      } else {
        for (const sub of relay.subs.values()) if (sub.caughtUp) sub.aliveAt = relay.heardAt
      }
      heartbeat(relay)
    }, HEARTBEAT)
  }

  function open(relay) {
    if (relay.socket || relay.retry || !relay.subs.size) return
    let socket
    try { socket = createSocket(relay.url) } catch { relay.socket = null; drop(relay, 'Relay connection failed'); return }
    relay.socket = socket
    for (const sub of relay.subs.values()) sub.caughtUp = false
    const connecting = later(relay, () => drop(relay, 'Relay connection timed out'), CONNECT_TIMEOUT)
    socket.onopen = () => {
      clearTimeout(connecting)
      relay.timers.delete(connecting)
      relay.heardAt = now()
      for (const id of relay.subs.keys()) request(relay, id)
      heartbeat(relay)
    }
    socket.onerror = () => drop(relay, 'Relay connection failed')
    socket.onclose = () => drop(relay, 'Relay closed the connection')
    socket.onmessage = message => receive(relay, socket, message)
  }

  async function authenticate(relay, socket, challenge) {
    relay.authed = false
    try {
      const signed = await signAuth(relay.url, challenge)
      if (relay.socket !== socket) return
      relay.authId = signed.id
      send(relay, ['AUTH', signed])
    } catch {
      if (relay.socket === socket) drop(relay, 'Relay sign-in failed', AUTH_RETRY)
    }
  }

  function receive(relay, socket, message) {
    let frame
    try { frame = JSON.parse(message.data) } catch { return }
    if (!Array.isArray(frame)) return
    relay.heardAt = now()
    const [type, id] = frame
    if (type === 'AUTH') { void authenticate(relay, socket, id); return }
    if (type === 'OK' && relay.authId && id === relay.authId) {
      if (!frame[2]) { drop(relay, 'Relay rejected sign-in', AUTH_RETRY); return }
      relay.authed = true
      for (const subId of relay.subs.keys()) request(relay, subId)
      return
    }
    if (id === PROBE) {
      if (type === 'EOSE') send(relay, ['CLOSE', PROBE])
      for (const sub of relay.subs.values()) if (sub.caughtUp) sub.aliveAt = relay.heardAt
      return
    }
    const sub = relay.subs.get(id)
    if (!sub) return
    if (type === 'EVENT' && frame[2]) {
      sub.onEvent(frame[2])
      if (sub.caughtUp) sub.aliveAt = relay.heardAt
    } else if (type === 'EOSE') {
      sub.caughtUp = true
      sub.attempts = 0
      sub.aliveAt = relay.heardAt
      relay.attempts = 0
    } else if (type === 'CLOSED') {
      sub.caughtUp = false
      sub.onError(new Error(`Relay refused request: ${frame[2] || relay.url}`))
      // A pending sign-in resends every request; this retry covers every other case.
      const base = String(frame[2] || '').startsWith('auth-required') && relay.authed ? AUTH_RETRY : 2000
      clearTimeout(sub.retry)
      sub.retry = setTimeout(() => request(relay, id), Math.min(AUTH_RETRY, base * 2 ** sub.attempts))
      sub.attempts += 1
    }
  }

  return {
    subscribe(urls, filters, observer) {
      let active = true
      const known = new Set()
      const id = `ncc-live-${++nextId}`
      const used = [...new Set(urls)].map(relayFor)
      for (const relay of used) {
        relay.subs.set(id, {
          filters, aliveAt: null, caughtUp: false, attempts: 0, retry: null,
          onEvent: event => {
            if (!active || known.has(event.id)) return
            known.add(event.id)
            observer.next?.(event)
          },
          onError: error => { if (active) observer.error?.(error) }
        })
        if (!relay.socket) open(relay)
        else request(relay, id)
      }
      return () => {
        if (!active) return
        active = false
        for (const relay of used) {
          const sub = relay.subs.get(id)
          if (!sub) continue
          clearTimeout(sub.retry)
          send(relay, ['CLOSE', id])
          relay.subs.delete(id)
          if (!relay.subs.size) { detach(relay); relays.delete(relay.url) }
        }
      }
    },
    // Reopens every connection, for a changed account or a returned network.
    reconnect() {
      for (const relay of relays.values()) {
        detach(relay)
        relay.attempts = 0
        open(relay)
      }
    },
    get connections() { return [...relays.values()].filter(relay => relay.socket).length }
  }
}
