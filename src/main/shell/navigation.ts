import { parseNccAddress, toDisplayUrl, toInternalUrl, type NccAddress } from '@shared/ncc-url'
import { buildNsiteUrl, parseNsiteAddress, type NsiteAddress } from '@shared/nsite-url'
import { renderErrorPage } from '../error-page'
import {
  isHttpExemptUrl,
  shouldUpgradeHttp,
  upgradeToHttps,
  webHttpKey
} from '../security'
import { formatDisplayUrl, isOnionPageUrl } from './format'
import type { ShellInternals } from './internals'
import type { Tab } from './types'

export async function navigateInTab(
  internals: ShellInternals,
  tab: Tab,
  input: string
): Promise<void> {
  const text = input.trim()
  if (!text) return

  // Any navigation replaces a restored address that has not been loaded yet.
  tab.pendingUrl = null
  internals.activateTab(tab.id)

  if (tab.kind === 'tor') {
    tab.loading = true
    internals.syncState()
    try {
      await internals.deps.tor.ensureReady()
    } catch (error) {
      await loadWebError(
        internals,
        tab,
        text,
        'tor-unavailable',
        error instanceof Error ? error.message : String(error)
      )
      return
    }
  }

  const target = internals.deps.omnibox.classify(text, tab.kind)
  if (target.kind === 'invalid') {
    tab.failure = { code: target.code, message: target.message }
    internals.syncState()
    return
  }

  if (target.kind === 'web' || target.kind === 'search') {
    await openWebUrl(internals, tab, target.url)
    return
  }

  if (target.kind === 'nsite') {
    let nsite: NsiteAddress
    try {
      nsite = parseNsiteAddress(target.url)
    } catch (error) {
      tab.failure = {
        code: 'invalid-address',
        message: error instanceof Error ? error.message : 'Invalid nsite address'
      }
      internals.syncState()
      return
    }
    tab.mode = 'nsite'
    tab.pubkey = nsite.pubkey
    tab.service = nsite.site
    tab.displayUrl = buildNsiteUrl(nsite)
    tab.security = null
    tab.failure = null
    tab.tor = { onionAvailable: false, active: tab.kind === 'tor' }
    internals.deps.torGuard.set(tab.view.webContents.id, tab.kind === 'tor')
    internals.showOnly(tab.id)
    await loadPage(internals, tab, buildNsiteUrl(nsite))
    return
  }

  let address: NccAddress
  try {
    address = parseNccAddress(target.url)
  } catch (error) {
    tab.failure = {
      code: 'invalid-address',
      message: error instanceof Error ? error.message : 'Invalid address'
    }
    internals.syncState()
    return
  }

  internals.deps.activeServices[tab.kind].set(address.pubkey, address.service)
  tab.mode = 'ncc'
  tab.pubkey = address.pubkey
  tab.service = address.service
  const internal = toInternalUrl(address)
  tab.displayUrl = toDisplayUrl(internal)
  tab.security = null
  tab.failure = null
  internals.showOnly(tab.id)
  await loadPage(internals, tab, internal)
}

/** Open a web or search URL, applying the same HTTPS policy as typed addresses. */
async function openWebUrl(
  internals: ShellInternals,
  tab: Tab,
  text: string
): Promise<void> {
  const policy = internals.deps.httpPolicies[tab.kind]
  const key = webHttpKey(text)
  const http = /^http:\/\//i.test(text)
  const exempt = isHttpExemptUrl(text)

  if (http && key && !exempt && !policy.isAllowed(key)) {
    if (shouldUpgradeHttp(text, policy.mode())) {
      const httpsUrl = upgradeToHttps(text)
      await loadWebTarget(internals, tab, httpsUrl, { original: text, key, httpsUrl })
      return
    }
    if (policy.warn()) {
      internals.showInsecurePrompt(tab, text, key)
      return
    }
  }

  await loadWebTarget(internals, tab, text)
}

export async function loadWebTarget(
  internals: ShellInternals,
  tab: Tab,
  text: string,
  pending: Tab['pendingHttp'] = null
): Promise<void> {
  tab.mode = 'web'
  tab.pubkey = null
  tab.service = null
  tab.displayUrl = text
  tab.security = null
  tab.failure = null
  tab.pendingHttp = pending
  tab.tor = { onionAvailable: false, active: false }
  internals.deps.torGuard.set(tab.view.webContents.id, false)
  internals.showOnly(tab.id)

  if (isOnionPageUrl(text)) {
    tab.loading = true
    internals.syncState()
    try {
      await internals.deps.tor.ensureReady()
    } catch (error) {
      await loadWebError(
        internals,
        tab,
        text,
        'tor-unavailable',
        error instanceof Error ? error.message : String(error)
      )
      return
    }
    tab.tor.active = true
    internals.deps.torGuard.set(tab.view.webContents.id, true)
  }

  tab.programmatic = true
  try {
    await loadPage(internals, tab, text)
  } finally {
    tab.programmatic = false
  }
}

export async function loadWebError(
  internals: ShellInternals,
  tab: Tab,
  address: string,
  code: string,
  message: string
): Promise<void> {
  const html = renderErrorPage({ code, message, address })
  await loadPage(
    internals,
    tab,
    `data:text/html;base64,${Buffer.from(html).toString('base64')}`
  )
  tab.mode = 'web'
  tab.displayUrl = address
  tab.security = null
  tab.failure = { code, message }
  tab.tor = { onionAvailable: false, active: false }
  internals.deps.torGuard.set(tab.view.webContents.id, false)
  internals.syncState()
}

async function loadPage(internals: ShellInternals, tab: Tab, url: string): Promise<void> {
  try {
    await tab.view.webContents.loadURL(url)
  } catch (error) {
    // Chromium reports aborted navigations as errors too; only surface real failures.
    const message = error instanceof Error ? error.message : String(error)
    if (!/ERR_ABORTED/i.test(message)) {
      tab.failure ??= {
        code: url.startsWith('ncc://') ? 'endpoint-unreachable' : 'load-failed',
        message
      }
    }
    internals.syncState()
  }
}

export function applyUrlToTab(tab: Tab, url: string): void {
  if (url.startsWith('nsite://')) {
    tab.mode = 'nsite'
    try {
      const address = parseNsiteAddress(url)
      tab.pubkey = address.pubkey
      tab.service = address.site
    } catch {
      // The error page's own URL may not parse; keep the previous site.
    }
    return
  }

  if (!url.startsWith('ncc://')) {
    tab.mode = url.startsWith('http') ? 'web' : tab.mode
    if (!url.startsWith('http')) return
    tab.pubkey = null
    tab.service = null
    return
  }

  tab.mode = 'ncc'
  try {
    const address = parseNccAddress(url)
    tab.pubkey = address.pubkey
    tab.service = address.service
  } catch {
    // The error page's own URL may not parse; keep the previous service.
  }
}

export { formatDisplayUrl }
