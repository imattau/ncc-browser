/**
 * The origin a NIP-07 request is attributed to. One `ncc://<npub>/<service>` address is
 * one origin, matching how the protocol handler partitions storage; clearnet pages use
 * their usual `scheme://host:port` origin.
 *
 * Kept separate from the IPC wiring so the site panel can label a page without loading
 * anything, and so both paths agree on exactly one derivation.
 */

import { parseNccAddress } from '@shared/ncc-url'
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
    try {
      const parsed = parseNccAddress(raw)
      const label = `ncc://${parsed.pubkey}/${parsed.service}`
      return { origin: label, label }
    } catch {
      return null
    }
  }

  if (url.protocol === 'nsite:') {
    try {
      const parsed = parseNsiteAddress(raw)
      return { origin: nsiteOrigin(parsed.pubkey, parsed.site), label: nsiteOrigin(parsed.pubkey, parsed.site) }
    } catch {
      return null
    }
  }

  if (url.protocol === 'nccsearch:' && url.hostname === 'app') {
    return { origin: 'nccsearch://app', label: 'Nostr Navigator nccsearch' }
  }

  if (url.protocol === 'https:' || url.protocol === 'http:') {
    return { origin: url.origin, label: url.origin }
  }

  return null
}
