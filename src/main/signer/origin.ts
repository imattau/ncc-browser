/**
 * The origin a NIP-07 request is attributed to. One `ncc://<npub>/<service>` address is
 * one origin, matching how the protocol handler partitions storage; clearnet pages use
 * their usual `scheme://host:port` origin.
 *
 * Kept separate from the IPC wiring so the site panel can label a page without loading
 * anything, and so both paths agree on exactly one derivation.
 */

import { isNostrId } from '@shared/ncc-url'
import { nsiteOrigin, parseNsiteAddress } from '@shared/nsite-url'

export interface SignerOrigin {
  origin: string
  label: string
}

export function signerOriginFromUrl(raw: string): SignerOrigin | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol === 'ncc:') {
    const pubkey = url.hostname.toLowerCase()
    if (!isNostrId(pubkey)) return null
    const path = url.pathname.replace(/^\/+/, '')
    const service = path.startsWith('_/') ? path.slice(2).split('/')[0] : path.split('/')[0]
    const label = `ncc://${pubkey}/${service || 'addr'}`
    return { origin: label, label }
  }

  if (url.protocol === 'nsite:') {
    try {
      const parsed = parseNsiteAddress(raw)
      return { origin: nsiteOrigin(parsed.pubkey, parsed.site), label: nsiteOrigin(parsed.pubkey, parsed.site) }
    } catch {
      return null
    }
  }

  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return { origin: url.origin, label: url.origin }
  }

  return null
}
