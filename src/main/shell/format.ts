import { toDisplayUrl } from '@shared/ncc-url'
import { toNsiteDisplayUrl } from '@shared/nsite-url'
import { isOnionHost } from '../tor/guard'
import type { Tab } from './types'

/** The best title available without trusting a custom-scheme URL as a title. */
export function tabTitle(tab: Tab): string {
  const contents = tab.view.webContents
  if (contents.isDestroyed()) return tab.displayUrl || 'New tab'
  const title = contents.getTitle()
  if (title && !title.startsWith('ncc://') && !title.startsWith('http')) return title
  return tab.displayUrl || 'New tab'
}

export function safeProtocol(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

export function formatDisplayUrl(url: string): string {
  if (url.startsWith('ncc://')) return toDisplayUrl(url)
  if (url.startsWith('nsite://')) return toNsiteDisplayUrl(url)
  return url
}

export function isOnionPageUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    return isOnionHost(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function historyLabel(title: string, url: string): string {
  const label = title?.trim() || url
  return label.length > 100 ? `${label.slice(0, 100)}…` : label
}
