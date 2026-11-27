import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TorControl,
  TorControlError,
  onionServiceIdFromHost,
  parseOnionReply
} from '../src/main/tor/control'

const sockets: Socket[] = []
const servers: Server[] = []

function serve(handler: (line: string) => string | null): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      sockets.push(socket)
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        for (;;) {
          const index = buffer.indexOf('\r\n')
          if (index === -1) return
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const reply = handler(line)
          if (reply) socket.write(reply)
        }
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.close()
})

describe('onion service ids', () => {
  it('accepts v3 ids with or without the suffix', () => {
    expect(onionServiceIdFromHost('abcdefghijklmnop.onion')).toBe('abcdefghijklmnop')
    expect(onionServiceIdFromHost('ABCDEFGHIJKLMNOP')).toBe('abcdefghijklmnop')
    expect(onionServiceIdFromHost('not-onion')).toBeNull()
    expect(onionServiceIdFromHost('short.onion')).toBeNull()
  })

  it('parses an ADD_ONION reply and rejects partial replies', () => {
    expect(
      parseOnionReply({
        code: 250,
        lines: ['ServiceID=abcdefghijklmnop', 'PrivateKey=ED25519-V3:secret', 'OK']
      })
    ).toEqual({ serviceId: 'abcdefghijklmnop', privateKey: 'ED25519-V3:secret' })
    expect(() => parseOnionReply({ code: 250, lines: ['ServiceID=abcdefghijklmnop'] })).toThrow(
      TorControlError
    )
  })
})

describe('TorControl', () => {
  it('authenticates with the cookie and parses a multiline reply', async () => {
    const cookie = join(mkdtempSync(join(tmpdir(), 'ncc-tor-cookie-')), 'control_auth_cookie')
    writeFileSync(cookie, Buffer.from([0x01, 0xab, 0xff]))
    const seen: string[] = []
    const port = await serve((line) => {
      seen.push(line)
      if (line.startsWith('AUTHENTICATE')) return '250 OK\r\n'
      if (line.startsWith('ADD_ONION')) {
        return [
          '250-ServiceID=abcdefghijklmnop',
          '250-PrivateKey=ED25519-V3:secret',
          '250 OK',
          ''
        ].join('\r\n')
      }
      return null
    })

    const control = new TorControl({ port, cookiePath: cookie })
    await control.connect()
    expect(seen[0]).toBe('AUTHENTICATE 01abff')
    const added = await control.addOnion({ virtualPort: 80, targetPort: 8080 })
    expect(seen[1]).toBe('ADD_ONION NEW:ED25519-V3 Port=80,127.0.0.1:8080')
    expect(added).toEqual({ serviceId: 'abcdefghijklmnop', privateKey: 'ED25519-V3:secret' })
    control.close()
  })

  it('reuses a stored key and deletes services', async () => {
    const seen: string[] = []
    const port = await serve((line) => {
      seen.push(line)
      // As real Tor does: no PrivateKey line when the caller supplied the key.
      if (line.startsWith('ADD_ONION')) return '250-ServiceID=abcdefghijklmnop\r\n250 OK\r\n'
      return '250 OK\r\n'
    })
    const control = new TorControl({ port, password: 'pw' })
    await control.connect()
    await expect(
      control.addOnion({ virtualPort: 443, targetPort: 8443, privateKey: 'ED25519-V3:stored' })
    ).resolves.toEqual({ serviceId: 'abcdefghijklmnop', privateKey: 'ED25519-V3:stored' })
    await control.delOnion('abcdefghijklmnop')
    expect(seen).toContain('AUTHENTICATE "pw"')
    expect(seen).toContain('ADD_ONION ED25519-V3:stored Port=443,127.0.0.1:8443')
    expect(seen).toContain('DEL_ONION abcdefghijklmnop')
    control.close()
  })

  it('surfaces a Tor error reply and rejects invalid ids', async () => {
    const port = await serve((line) => {
      if (line.startsWith('ADD_ONION')) return '552 Unrecognized key type\r\n'
      return '250 OK\r\n'
    })
    const control = new TorControl({ port })
    await control.connect()
    await expect(
      control.addOnion({ virtualPort: 80, targetPort: 8080 })
    ).rejects.toThrow('Unrecognized key type')
    await expect(control.delOnion('bad')).rejects.toThrow('Invalid onion service id')
    control.close()
  })
})
