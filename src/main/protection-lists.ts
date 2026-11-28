/** Which filter lists to download again, and which downloads to accept. */

export const LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const LIST_MAX_BYTES = 12_000_000

/**
 * A list may legitimately be nearly empty (`brave-unbreak` is just its title comment),
 * so a short body is accepted when it reads as a filter list. An HTML page is not one.
 */
export function isUsableList(body: string): boolean {
  if (body.length > LIST_MAX_BYTES) return false
  const start = body.trimStart()
  if (start.startsWith('<')) return false
  return body.length >= 100 || start.startsWith('!') || start.startsWith('[Adblock')
}

/** `modified` is null for a list that has never been saved. */
export function isListStale(modified: number | null, now: number): boolean {
  return modified === null || now - modified >= LIST_MAX_AGE_MS
}

/**
 * Hides matching elements now and as the page changes. Changes are batched: a busy
 * page mutates far more often than it needs to be searched again.
 */
export function cosmeticHideScript(selectors: string[]): string {
  return `(()=>{const s=${JSON.stringify(selectors.join(','))};const apply=()=>{try{document.querySelectorAll(s).forEach(e=>e.remove())}catch{}};apply();let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;setTimeout(()=>{queued=false;apply()},200)}).observe(document.documentElement,{childList:true,subtree:true})})()`
}
