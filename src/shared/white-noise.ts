/**
 * White Noise (whitenoise.chat) is a separate MLS/Nostr messenger app. ncc-browser only
 * hands it an npub to open a chat with; it never shares identity, signing, or session
 * state with it.
 */

const NPUB_RE = /^npub1[a-z0-9]{20,}$/

export function isNpub(value: string): boolean {
  return NPUB_RE.test(value)
}

/** The deep link White Noise registers for starting a chat with a given npub. */
export function whiteNoiseUserUrl(npub: string): string {
  if (!isNpub(npub)) throw new Error('Not a valid npub')
  return `whitenoise://user/${npub}`
}
