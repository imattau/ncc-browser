import type { WebContents } from 'electron'

/**
 * Which agent (if any) a tab belongs to, so a NIP-07 call from that tab can be answered
 * by that agent's own Nostr identity instead of the human's. Set only when the `tab_new`
 * tool creates the tab — navigating or clicking on an existing tab never changes whose
 * identity answers for it.
 */
const owners = new WeakMap<WebContents, string>()

export function tagTab(contents: WebContents, agentId: string): void {
  owners.set(contents, agentId)
}

export function agentIdForContents(contents: WebContents): string | null {
  return owners.get(contents) ?? null
}
