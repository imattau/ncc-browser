/** Clearnet connection state for the toolbar lock. Pure so it is easy to test. */

export type ClearnetTone = 'ok' | 'warn' | 'muted'
export type ClearnetLabel = 'secure' | 'insecure' | 'web' | 'onion'

export interface ClearnetState {
  tone: ClearnetTone
  label: ClearnetLabel
  host: string
}

export function clearnetState(url: string): ClearnetState {
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }

  if (parsed && parsed.hostname.toLowerCase().endsWith('.onion')) {
    return {
      tone: parsed.protocol === 'https:' ? 'ok' : 'warn',
      label: 'onion',
      host: parsed.host
    }
  }
  if (parsed?.protocol === 'https:') {
    return { tone: 'ok', label: 'secure', host: parsed.host }
  }
  if (parsed?.protocol === 'http:') {
    return { tone: 'warn', label: 'insecure', host: parsed.host }
  }
  return { tone: 'muted', label: 'web', host: parsed?.host ?? '' }
}
