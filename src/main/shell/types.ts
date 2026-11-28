import type { WebContentsView, WebPreferences } from 'electron'
import { TOR_TAB_ARGUMENT } from '@shared/tor-identity'
import type { PageMode, SecurityInfo, TabKind } from '@shared/types'
import type { BrowserShell } from '../shell'

/** One content view and the state the chrome needs to render its tab. */
export interface Tab {
  owner: BrowserShell
  id: string
  kind: TabKind
  view: WebContentsView
  mode: PageMode
  displayUrl: string
  /** A restored background tab's address, until the tab is first shown. */
  pendingUrl?: string | null
  pubkey: string | null
  service: string | null
  security: SecurityInfo | null
  failure: { code: string; message: string } | null
  tor: { onionAvailable: boolean; active: boolean }
  pendingHttp: { original: string; key: string; httpsUrl: string } | null
  programmatic: boolean
  loading: boolean
  favicon: string | null
  audible: boolean
  muted: boolean
}

export const CONTENT_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
  safeDialogs: true
} as const

/**
 * A Tor tab's preload also runs in frames, only to give their scripts the same
 * anonymous language as the page. `sandbox` still applies: no frame gets Node.
 */
export function contentWebPreferences(kind: TabKind): WebPreferences {
  if (kind !== 'tor') return { ...CONTENT_WEB_PREFERENCES }
  return {
    ...CONTENT_WEB_PREFERENCES,
    nodeIntegrationInSubFrames: true,
    additionalArguments: [TOR_TAB_ARGUMENT]
  }
}
