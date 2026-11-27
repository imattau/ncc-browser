import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { WebSocketServer } from 'ws'
import { RelayPool } from '../src/main/relay/pool'
import { RelayPinStore } from '../src/main/relay/socket'

describe('RelayPool.queryAuthReport', () => {
  let healthy: WebSocketServer
  let slow: WebSocketServer
  const urls = { healthy: '', slow: '' }

  const listen = async (server: WebSocketServer): Promise<string> => {
    await new Promise((resolve) => server.once('listening', resolve))
    return `ws://127.0.0.1:${(server.address() as { port: number }).port}`
  }

  beforeAll(async () => {
    healthy = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    healthy.on('connection', (socket) => {
      socket.on('message', (data) => {
        const [type, body] = JSON.parse(String(data))
        if (type === 'REQ') socket.send(JSON.stringify(['EOSE', body]))
        if (type === 'EVENT') socket.send(JSON.stringify(['OK', body.id, true, '']))
      })
    })
    urls.healthy = await listen(healthy)
    // Connects late and then says nothing, so it is still waiting at the time limit.
    slow = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: (_info: unknown, done: (accept: boolean) => void) => void setTimeout(() => done(true), 2_500)
    })
    urls.slow = await listen(slow)
  })

  afterAll(() => {
    for (const server of [healthy, slow]) {
      for (const socket of server.clients) socket.terminate()
      server.close()
    }
  })

  const ask = async (relays: string[]) => {
    const pool = new RelayPool({ pins: new RelayPinStore(), proxy: () => null })
    try {
      return await pool.queryAuthReport(relays, { kinds: [30078], limit: 1 })
    } finally {
      pool.closeAll()
    }
  }

  it('still counts the others when one relay is too slow', async () => {
    expect(await ask([urls.healthy, urls.slow])).toMatchObject({ asked: 2, answered: 1, unanswered: [urls.slow] })
  }, 15_000)

  it('finishes both sends when one relay is written two ways', async () => {
    const pool = new RelayPool({ pins: new RelayPinStore(), proxy: () => null })
    const event = finalizeEvent({ kind: 1, created_at: 1, tags: [], content: '' }, generateSecretKey())
    try {
      await pool.queryAuthReport([urls.healthy], { kinds: [1], limit: 1 })
      const sends = [urls.healthy, `${urls.healthy}/`].map((url) => pool.publishWithAuth(url, event))
      expect(await Promise.all(sends)).toHaveLength(2)
    } finally {
      pool.closeAll()
    }
  }, 10_000)

  it('asks one relay written two ways once', async () => {
    expect(await ask([urls.healthy, `${urls.healthy}/`])).toMatchObject({ asked: 1, answered: 1, unanswered: [] })
  })
})
