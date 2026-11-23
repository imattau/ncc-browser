import { createSocket } from 'node:dgram'

export interface NatPmpMapRequest {
  internalPort: number
  externalPort?: number
  protocol?: 'TCP' | 'UDP'
  lifetimeSeconds?: number
}

export function encodeNatPmpMap(request: NatPmpMapRequest): {
  packet: Buffer
  opcode: number
} {
  const opcode = request.protocol === 'UDP' ? 1 : 2
  const lifetime = Math.max(0, Math.min(0xffffffff, request.lifetimeSeconds ?? 7200))
  const packet = Buffer.alloc(12)
  packet[1] = opcode
  packet.writeUInt16BE(request.internalPort, 4)
  packet.writeUInt16BE(request.externalPort ?? request.internalPort, 6)
  packet.writeUInt32BE(lifetime, 8)
  return { packet, opcode }
}

export function parseNatPmpMapResponse(data: Buffer, opcode: number): number | null {
  if (data.length < 16 || data[1] !== opcode + 128 || data.readUInt16BE(2) !== 0) return null
  return data.readUInt16BE(10)
}

/** NAT-PMP mapping request (RFC 6886). Returns the external port the router granted. */
export function natPmpMapPort(
  gateway: string,
  request: NatPmpMapRequest,
  timeoutMs = 2500
): Promise<number> {
  const { packet, opcode } = encodeNatPmpMap(request)
  return natPmpRequest(gateway, packet, opcode, timeoutMs, (data) => {
    const port = parseNatPmpMapResponse(data, opcode)
    if (port === null) throw new Error('NAT-PMP returned an invalid mapping response')
    return port
  })
}

/** Ask NAT-PMP to drop a mapping by replacing it with a zero lifetime. */
export function natPmpDeletePort(
  gateway: string,
  externalPort: number,
  timeoutMs = 2000
): Promise<number> {
  const packet = Buffer.alloc(12)
  packet[1] = 2
  packet.writeUInt16BE(0, 4)
  packet.writeUInt16BE(externalPort, 6)
  packet.writeUInt32BE(0, 8)
  return natPmpRequest(gateway, packet, 2, timeoutMs, () => externalPort)
}

function natPmpRequest<T>(
  gateway: string,
  packet: Buffer,
  opcode: number,
  timeoutMs: number,
  read: (data: Buffer) => T
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4')
    let settled = false
    const finish = (error: Error | null, value?: T): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // ignore
      }
      if (error) reject(error)
      else resolve(value as T)
    }
    socket.on('error', (error) => finish(error))
    socket.on('message', (data) => {
      if (data.length < 16 || data[1] !== opcode + 128) {
        return finish(new Error('NAT-PMP returned an unexpected response'))
      }
      const result = data.readUInt16BE(2)
      if (result !== 0) {
        return finish(new Error(`NAT-PMP error ${result}`))
      }
      try {
        finish(null, read(data))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.send(packet, 5351, gateway, (error) => {
      if (error) finish(error)
    })
    setTimeout(() => finish(new Error('NAT-PMP did not answer')), timeoutMs)
  })
}

/** NAT-PMP public address request (RFC 6886). */
export function natPmpExternalAddress(gateway: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(value)
    }
    socket.on('error', () => finish(null))
    socket.on('message', (data) => {
      if (data.length < 12 || data[1] !== 128) return finish(null)
      const result = data.readUInt16BE(2)
      if (result !== 0) return finish(null)
      finish(`${data[8]}.${data[9]}.${data[10]}.${data[11]}`)
    })
    socket.send(Buffer.from([0, 0]), 5351, gateway, (error) => {
      if (error) finish(null)
    })
    setTimeout(() => finish(null), timeoutMs)
  })
}
