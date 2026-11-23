import { createSocket } from 'node:dgram'
import { requestText } from '../http-text'

export interface UpnpGateway {
  serviceType: string
  controlUrl: string
  externalAddress?: string
}

/** Find the router's WAN control service from its device description. */
export async function findUpnpGateway(timeoutMs: number): Promise<UpnpGateway | null> {
  const location = await ssdpLocation(timeoutMs)
  if (!location) return null
  try {
    const description = await fetchText(location, timeoutMs)
    const base = /<URLBase>\s*([^<]+?)\s*<\/URLBase>/i.exec(description)?.[1] ?? location
    const service = /<service>([\s\S]*?)<\/service>/gi
    let controlUrl = ''
    let serviceType = ''
    for (const match of description.matchAll(service)) {
      const block = match[1]
      const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1] ?? ''
      if (!/WANIPConnection|WANPPPConnection/i.test(type)) continue
      controlUrl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1] ?? ''
      serviceType = type
      if (controlUrl) break
    }
    if (!controlUrl || !serviceType) return null
    return { serviceType, controlUrl: new URL(controlUrl, base).toString() }
  } catch {
    return null
  }
}

function xml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function soapAction(
  gateway: UpnpGateway,
  action: string,
  args: Array<[string, string | number]>,
  timeoutMs: number
): Promise<string> {
  const values = args.map(([name, value]) => `<${name}>${xml(value)}</${name}>`).join('')
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${gateway.serviceType}">${values}</u:${action}></s:Body></s:Envelope>`
  return fetchText(gateway.controlUrl, timeoutMs, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${gateway.serviceType}#${action}"`,
      Connection: 'close'
    },
    body
  })
}

export interface PortMappingRequest {
  externalPort: number
  internalPort: number
  internalClient: string
  protocol?: 'TCP' | 'UDP'
  description?: string
  leaseSeconds?: number
}

/** Ask the router to forward a TCP/UDP port to a LAN client. */
export async function addUpnpPortMapping(
  gateway: UpnpGateway,
  request: PortMappingRequest,
  timeoutMs = 4000
): Promise<void> {
  await soapAction(
    gateway,
    'AddPortMapping',
    [
      ['NewRemoteHost', ''],
      ['NewExternalPort', request.externalPort],
      ['NewProtocol', request.protocol ?? 'TCP'],
      ['NewInternalPort', request.internalPort],
      ['NewInternalClient', request.internalClient],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', request.description ?? 'Nostr Navigator'],
      ['NewLeaseDuration', request.leaseSeconds ?? 7200]
    ],
    timeoutMs
  )
}

export async function deleteUpnpPortMapping(
  gateway: UpnpGateway,
  externalPort: number,
  protocol: 'TCP' | 'UDP' = 'TCP',
  timeoutMs = 4000
): Promise<void> {
  await soapAction(
    gateway,
    'DeletePortMapping',
    [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol]
    ],
    timeoutMs
  )
}

export async function upnpExternalAddressOn(
  gateway: UpnpGateway,
  timeoutMs = 4000
): Promise<string | null> {
  try {
    const response = await soapAction(gateway, 'GetExternalIPAddress', [], timeoutMs)
    return /<NewExternalIPAddress>\s*([^<]+?)\s*<\/NewExternalIPAddress>/i.exec(response)?.[1] ?? null
  } catch {
    return null
  }
}

/** Read a device description and run `GetExternalIPAddress` against its WAN service. */
export async function upnpExternalAddress(
  timeoutMs: number
): Promise<{ address: string; mapping: boolean; gateway: UpnpGateway } | null> {
  const gateway = await findUpnpGateway(timeoutMs)
  if (!gateway) return null
  const address = await upnpExternalAddressOn(gateway, timeoutMs)
  if (!address) return null
  gateway.externalAddress = address
  return { address, mapping: true, gateway }
}

async function fetchText(
  url: string,
  timeoutMs: number,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<string> {
  const response = await requestText(url, {
    timeoutMs,
    ...(init?.method ? { method: init.method } : {}),
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {})
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response.text
}

function ssdpLocation(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createSocket({ type: 'udp4' })
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
      const text = data.toString('utf8')
      const location = /^location:\s*(\S+)/im.exec(text)?.[1]
      if (location && /IGD|InternetGatewayDevice/i.test(text)) finish(location)
    })
    socket.bind(() => {
      const query = Buffer.from(
        [
          'M-SEARCH * HTTP/1.1',
          'HOST: 239.255.255.250:1900',
          'MAN: "ssdp:discover"',
          'MX: 2',
          'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
          '',
          ''
        ].join('\r\n')
      )
      socket.send(query, 1900, '239.255.255.250')
      socket.send(query, 1900, '239.255.255.250')
    })
    setTimeout(() => finish(null), timeoutMs)
  })
}
