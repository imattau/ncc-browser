import type { EndpointCandidate, EndpointKind } from '@shared/reachability'
import { normalizeEndpointSeed } from '@shared/reachability'

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export function endpoint(
  kind: EndpointKind,
  url: string,
  confidence: EndpointCandidate['confidence'],
  note?: string,
  family?: EndpointCandidate['family']
): EndpointCandidate {
  return {
    kind,
    url,
    ...(family ? { family } : {}),
    confidence,
    source: kind === 'current-https' || kind === 'public-v4' ? 'page' : 'interface',
    ...(note ? { note } : {})
  }
}

export function parseSeed(seedUrl: string): URL | null {
  const normalized = normalizeEndpointSeed(seedUrl)
  if (!normalized) return null
  try {
    return new URL(normalized)
  } catch {
    return null
  }
}

export function seedPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

export function buildUrl(scheme: 'http' | 'https', host: string, port: number, seed: URL): string {
  const suffix = `${seed.pathname || '/'}${seed.search || ''}`
  return `${scheme}://${formatHost(host)}:${port}${suffix}`
}
