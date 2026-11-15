/**
 * The unit a user grants control over: a web origin, or one ncc/nsite service.
 *
 * Both the display form (`ncc://<npub>/<service>/…`) and the host form the content
 * view actually loads (`ncc://<npub>.<service>/…`) reduce to the same string, so an
 * approval, a page URL and a console entry always compare equal for one service.
 */

import { parseNccAddress } from '@shared/ncc-url'
import { parseNsiteAddress } from '@shared/nsite-url'

export function siteOf(input: string): string {
  const raw = input.trim()
  if (!raw) return 'about:blank'
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin

    if (url.protocol === 'ncc:') {
      try {
        const address = parseNccAddress(candidate)
        return `ncc://${address.pubkey}/${address.service}`
      } catch {
        return `${url.protocol}//${url.host}`
      }
    }

    if (url.protocol === 'nsite:') {
      try {
        const address = parseNsiteAddress(candidate)
        return address.site
          ? `nsite://${address.pubkey}/${address.site}`
          : `nsite://${address.pubkey}`
      } catch {
        return `${url.protocol}//${url.host}`
      }
    }

    return `${url.protocol}//${url.host}`
  } catch {
    return raw.slice(0, 80)
  }
}
