/**
 * The decisions behind the guided publishing screens: suggested names, address
 * checks and what to do next. Pure, so they can be tested without a window.
 */
import { isLoopbackHost, type HostedService } from '@shared/hosting'
import { normalizeEndpointSeed } from '@shared/reachability'

/** Build output folders, whose names say nothing about the site inside. */
const BUILD_FOLDERS = new Set(['dist', 'build', 'public', 'out', 'output', '_site', 'site', 'www'])
const MAX_SITE_ID = 13

/**
 * A short address name from a title. Whole words are kept where they fit, so
 * "My holiday site" becomes `my-holiday`, not `my-holiday-si`.
 */
export function suggestSiteId(title: string): string {
  const words = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let id = ''
  for (const word of words) {
    const next = id ? `${id}-${word}` : word
    if (next.length > MAX_SITE_ID) break
    id = next
  }
  return id || (words[0] ?? '').slice(0, MAX_SITE_ID)
}

export function suggestSiteTitle(folderName: string): string {
  if (BUILD_FOLDERS.has(folderName.toLowerCase())) return ''
  const text = folderName.replace(/[-_.]+/g, ' ').trim()
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

export interface AddressCheck {
  /** One entry per usable line: what was typed, and the full URL to save. */
  entries: Array<{ line: string; url: string }>
  invalid: string[]
  hasLoopback: boolean
  /** Every address only works on this computer. */
  onlyLoopback: boolean
}

export function checkAddresses(text: string): AddressCheck {
  const entries: AddressCheck['entries'] = []
  const invalid: string[] = []
  let loopback = 0
  for (const line of text.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const url = normalizeEndpointSeed(line)
    if (!url) {
      invalid.push(line)
      continue
    }
    entries.push({ line, url })
    if (isLoopbackHost(new URL(url).hostname)) loopback += 1
  }
  return {
    entries,
    invalid,
    hasLoopback: loopback > 0,
    onlyLoopback: loopback > 0 && loopback === entries.length
  }
}

export interface NextStep {
  text: string
  action: 'edit' | 'publish' | 'onion' | 'people'
  button: string
}

/** The one thing a saved service is waiting for, if anything. */
export function serviceNextStep(
  service: Pick<HostedService, 'endpoints' | 'visibility' | 'lastPublishError' | 'lastPublishedAt' | 'ttlSeconds'>,
  activeShares: number,
  now: number
): NextStep | null {
  if (service.endpoints.length === 0) {
    return { text: 'Add the address of your app so it can be published.', action: 'edit', button: 'Add address' }
  }
  if (service.lastPublishError) {
    return { text: 'The last publish did not work.', action: 'publish', button: 'Try again' }
  }
  if (!service.lastPublishedAt) {
    return {
      text: 'Not published yet, so its address does not work.',
      action: 'publish',
      button: 'Publish now'
    }
  }
  if (service.lastPublishedAt + service.ttlSeconds <= now) {
    return {
      text: 'It has expired, so its address no longer works.',
      action: 'publish',
      button: 'Publish again'
    }
  }
  if (service.visibility !== 'private') return null
  if (checkAddresses(service.endpoints.map((endpoint) => endpoint.url).join('\n')).onlyLoopback) {
    return {
      text: 'Only this computer can open it. To share it, add a Tor address.',
      action: 'onion',
      button: 'Add Tor address'
    }
  }
  if (activeShares === 0) {
    return { text: 'Only you can open it so far.', action: 'people', button: 'Share with people' }
  }
  return null
}
