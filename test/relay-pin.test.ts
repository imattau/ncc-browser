import { createServer } from 'node:https'
import { X509Certificate } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import selfsigned from 'selfsigned'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'

import type { RelayEntry } from '../src/shared/types'
import { RelayPool } from '../src/main/relay/pool'
import {
  createRelayWebSocket,
  relayPinKey,
  RelayPinStore,
  spkiFingerprintFromDer
} from '../src/main/relay/socket'

interface TestRelay {
  url: string
  fingerprint: string
  close: () => Promise<void>
}

async function startRelay(): Promise<TestRelay> {
  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048,
    notAfterDate: new Date(Date.now() + 86_400_000)
  })
  const server = createServer({ key: pems.private, cert: pems.cert })
  const wss = new WebSocketServer({ server })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let message: unknown[]
      try {
        message = JSON.parse(String(data)) as unknown[]
      } catch {
        return
      }
      if (message[0] === 'REQ' && typeof message[1] === 'string') {
        socket.send(JSON.stringify(['EOSE', message[1]]))
      } else if (message[0] === 'EVENT' && message[1] && typeof message[1] === 'object') {
        const event = message[1] as { id?: string }
        socket.send(JSON.stringify(['OK', event.id ?? '', true, '']))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const fingerprint = spkiFingerprintFromDer(new X509Certificate(pems.cert).raw)
  if (!fingerprint) throw new Error('could not compute the test fingerprint')

  return {
    url: `wss://127.0.0.1:${port}`,
    fingerprint,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => server.close(() => resolve()))
      })
  }
}

function pinnedEntry(url: string, k: string): RelayEntry {
  return {
    url,
    locator: {
      identity: 'npub1test',
      pubkey: 'a'.repeat(64),
      service: 'relay',
      dTag: 'relay',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      k
    }
  }
}

function connect(url: string, pins: RelayPinStore): Promise<void> {
  const Implementation = createRelayWebSocket({ pins })
  return new Promise<void>((resolve, reject) => {
    const socket = new Implementation(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('timed out'))
    }, 5000)
    socket.once('open', () => {
      clearTimeout(timer)
      socket.close()
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('relay pinning', () => {
  it('keys pins by host and port, and only for wss', () => {
    expect(relayPinKey('wss://relay.example')).toBe('relay.example:443')
    expect(relayPinKey('WSS://Relay.Example:7447/path')).toBe('relay.example:7447')
    expect(relayPinKey('ws://relay.example')).toBeNull()
    expect(relayPinKey('https://relay.example')).toBeNull()
    expect(relayPinKey('not a url')).toBeNull()
  })

  it('stores a pin from a locator entry', () => {
    const pins = new RelayPinStore()
    pins.setForEntry(pinnedEntry('wss://relay.example', 'abc'))
    expect(pins.get('wss://relay.example')).toBe('abc')
    expect(pins.size()).toBe(1)
    pins.clearUrl('wss://relay.example')
    expect(pins.get('wss://relay.example')).toBeUndefined()
  })

  it('accepts a self-signed relay when the pin matches', async () => {
    const relay = await startRelay()
    try {
      const pins = new RelayPinStore()
      pins.setForEntry(pinnedEntry(relay.url, relay.fingerprint))
      await expect(connect(relay.url, pins)).resolves.toBeUndefined()
    } finally {
      await relay.close()
    }
  }, 20_000)

  it('rejects a self-signed relay whose pin does not match', async () => {
    const relay = await startRelay()
    try {
      const pins = new RelayPinStore()
      pins.setForEntry(pinnedEntry(relay.url, Buffer.from('wrong').toString('base64url')))
      await expect(connect(relay.url, pins)).rejects.toBeTruthy()
      expect(pins.consumeFailure(relay.url)).toBe('pin-mismatch')
    } finally {
      await relay.close()
    }
  }, 20_000)

  it('queries a pinned self-signed relay through the shared pool', async () => {
    const relay = await startRelay()
    try {
      const pins = new RelayPinStore()
      pins.setForEntry(pinnedEntry(relay.url, relay.fingerprint))
      const pool = new RelayPool({ pins, proxy: () => null })
      await expect(pool.query([relay.url], { kinds: [1] })).resolves.toEqual([])
      pool.closeUrls([relay.url])
    } finally {
      await relay.close()
    }
  }, 20_000)

  it('rejects a self-signed relay when the locator publishes no pin', async () => {
    const relay = await startRelay()
    try {
      const pins = new RelayPinStore()
      await expect(connect(relay.url, pins)).rejects.toBeTruthy()
    } finally {
      await relay.close()
    }
  }, 20_000)
})
