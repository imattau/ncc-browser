/**
 * What a desktop Tor tab says about the browser. Normal and private tabs carry a
 * `NostrNavigator/<version>` user-agent token that sites may rely on; through Tor the
 * same token would single its user out. Pure, for the main process and the preload.
 */

/** The header, and the list Electron builds that header from. */
export const TOR_ACCEPT_LANGUAGE = 'en-US,en;q=0.9'
export const TOR_LANGUAGE_LIST = 'en-US,en'

/** Passed to the content preload of a Tor tab, and to the popups it opens. */
export const TOR_TAB_ARGUMENT = '--ncc-tor-tab'

const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7'
}

/** Chrome's own reduced user agent, naming neither this app nor Electron. */
export function genericUserAgent(deviceAgent: string, platform: NodeJS.Platform): string {
  const major = /Chrome\/(\d+)/.exec(deviceAgent)?.[1] ?? '145'
  const system = PLATFORMS[platform] ?? 'X11; Linux x86_64'
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/** Request headers for the Tor session, without client hints or the device language. */
export function anonymiseTorHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower.startsWith('sec-ch-') || lower === 'accept-language') continue
    result[name] = value
  }
  result['Accept-Language'] = TOR_ACCEPT_LANGUAGE
  return result
}

/**
 * Runs in the page's own world, so it is serialised: it can use nothing from this
 * module. Electron's session language changes the header only, not what scripts see.
 */
export function useAnonymousLanguage(): void {
  const languages = Object.freeze(['en-US', 'en'])
  for (const [name, value] of [['language', 'en-US'], ['languages', languages]] as const) {
    Object.defineProperty(Navigator.prototype, name, {
      configurable: true,
      enumerable: true,
      get: () => value
    })
  }
  delete (Navigator.prototype as unknown as { userAgentData?: unknown }).userAgentData
}
