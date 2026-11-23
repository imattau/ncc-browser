import { useCallback, useEffect, useState } from 'react'
import type { ExtensionActionInfo, ExtensionsState } from '@shared/extensions'
import { sortDownloads } from '@shared/downloads'
import type { SyncDevice } from '@shared/sync-status'
import type {
  AppConfig,
  Bookmark,
  DownloadNotice,
  IdentityStatus,
  NavState,
  TabHistory
} from '@shared/types'
import { applyAppearance } from '../lib/appearance'

const EMPTY_STATE: NavState = {
  mode: 'blank',
  displayUrl: '',
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  security: null,
  failure: null,
  tor: { preferTor: false, onionAvailable: false, active: false, tabTor: false },
  tabKind: 'normal',
  banner: null,
  insecurePrompt: null,
  tabs: [],
  activeTabId: null,
  windowMaximized: false
}

export interface BrowserData {
  state: NavState
  config: AppConfig | null
  identity: IdentityStatus | null
  setIdentity: (status: IdentityStatus) => void
  downloads: DownloadNotice[]
  setDownloads: (next: DownloadNotice[]) => void
  bookmarks: Bookmark[]
  setBookmarks: (next: Bookmark[]) => void
  syncDevices: SyncDevice[]
  history: TabHistory | null
  refreshHistory: () => Promise<TabHistory>
  extensions: ExtensionsState | null
  extensionActions: ExtensionActionInfo[]
}

/** Browser state and the collections pushed by the main process. */
export function useBrowserData(): BrowserData {
  const [state, setState] = useState<NavState>(EMPTY_STATE)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [downloads, setDownloads] = useState<DownloadNotice[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [syncDevices, setSyncDevices] = useState<SyncDevice[]>([])
  const [history, setHistory] = useState<TabHistory | null>(null)
  const [extensions, setExtensions] = useState<ExtensionsState | null>(null)

  useEffect(() => {
    let alive = true
    void window.ncc.getState().then((next) => {
      if (alive) setState(next)
    })
    const unsubscribe = window.ncc.onState((next) => setState(next))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.ncc.identity().then((status) => {
      if (alive) setIdentity(status)
    })
    return () => {
      alive = false
    }
  }, [])

  // Appearance can change from Settings or from a main-process push; both arrive
  // as a config update.
  useEffect(
    () =>
      window.ncc.onConfig((next) => {
        setConfig(next)
        applyAppearance(next.appearance)
      }),
    []
  )

  useEffect(() => {
    let alive = true
    void window.ncc.getConfig().then((next) => {
      if (alive) setConfig(next)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    void window.ncc.extensionsState().then(setExtensions).catch(() => undefined)
    return window.ncc.onExtensions(setExtensions)
  }, [])

  useEffect(() => {
    let alive = true
    void window.ncc.bookmarks().then((next) => {
      if (alive) setBookmarks(next)
    })
    const offBookmarks = window.ncc.onBookmarks(setBookmarks)
    void window.ncc.syncStatus().then((next) => {
      if (alive) setSyncDevices(next.devices)
    })
    const offSync = window.ncc.onSyncStatus((next) => setSyncDevices(next.devices))
    return () => {
      alive = false
      offBookmarks()
      offSync()
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.ncc.downloads().then((next) => {
      if (alive) setDownloads(next)
    })
    const unsubscribe = window.ncc.onDownload((notice) => {
      setDownloads((current) =>
        sortDownloads([...current.filter((item) => item.id !== notice.id), notice])
      )
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const refreshHistory = useCallback(async (): Promise<TabHistory> => {
    const next = await window.ncc.tabHistory()
    setHistory(next)
    return next
  }, [])

  return {
    state,
    config,
    identity,
    setIdentity,
    downloads,
    setDownloads,
    bookmarks,
    setBookmarks,
    syncDevices,
    history,
    refreshHistory,
    extensions,
    extensionActions: extensions?.actions ?? []
  }
}
