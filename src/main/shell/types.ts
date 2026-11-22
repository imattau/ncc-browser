import type { WebContentsView } from 'electron'
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
