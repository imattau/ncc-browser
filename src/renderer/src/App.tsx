import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommandId } from '@shared/commands'
import { sortDownloads } from '@shared/downloads'
import type {
  Bookmark,
  DownloadNotice,
  IdentityStatus,
  NavState,
  OverlayReason,
  SignerRequest,
  TabHistory
} from '@shared/types'
import { ChromeMenu } from './components/ChromeMenu'
import { DownloadsPanel } from './components/DownloadsPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { type PopoverAnchor } from './components/Popover'
import { SettingsPage, type SettingsSection } from './components/SettingsPage'
import { SignerPrompt } from './components/SignerPrompt'
import { SiteInfoPanel } from './components/SiteInfoPanel'
import { TabOverflowMenu } from './components/TabOverflowMenu'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'

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
  tor: { preferTor: false, onionAvailable: false, active: false },
  tabs: [],
  activeTabId: null,
  windowMaximized: false
}

export function App() {
  const [state, setState] = useState<NavState>(EMPTY_STATE)
  const [overlay, setOverlay] = useState<OverlayReason | null>(null)
  const overlayRef = useRef<OverlayReason | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<DownloadNotice[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [signerRequest, setSignerRequest] = useState<SignerRequest | null>(null)
  const [history, setHistory] = useState<TabHistory | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [siteInfoAnchor, setSiteInfoAnchor] = useState<PopoverAnchor | null>(null)

  /**
   * One overlay at a time. The shell hides every content view while an overlay is
   * open, so popovers can cover the page area instead of being clipped to the chrome.
   */
  const showOverlay = useCallback((next: OverlayReason | null) => {
    const current = overlayRef.current
    if (current === next) return
    if (current) void window.ncc.setOverlay(current, false)
    overlayRef.current = next
    setOverlay(next)
    if (next) void window.ncc.setOverlay(next, true)
  }, [])

  const closeOverlay = useCallback(() => showOverlay(null), [showOverlay])

  const openSettings = useCallback(
    (section: SettingsSection = 'general') => {
      setSettingsSection(section)
      showOverlay('settings')
    },
    [showOverlay]
  )

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

  useEffect(() => {
    let alive = true
    void window.ncc.bookmarks().then((next) => {
      if (alive) setBookmarks(next)
    })
    const offBookmarks = window.ncc.onBookmarks(setBookmarks)
    return () => {
      alive = false
      offBookmarks()
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

  useEffect(() => {
    const unsubscribe = window.ncc.onSignerRequest((request) => {
      showOverlay(null)
      setSignerRequest(request)
    })
    const offResolved = window.ncc.onSignerResolved((id) =>
      setSignerRequest((current) => (current?.id === id ? null : current))
    )
    return () => {
      unsubscribe()
      offResolved()
    }
  }, [showOverlay])

  useEffect(() => {
    const offOpen = window.ncc.onOpenSettings((payload) =>
      openSettings(payload.section === 'identity' ? 'identity' : 'general')
    )
    const offClose = window.ncc.onCloseMenu(() => {
      // Window blur closes menus and popovers, but not a page the user is editing.
      if (overlayRef.current && overlayRef.current !== 'settings') showOverlay(null)
    })
    return () => {
      offOpen()
      offClose()
    }
  }, [openSettings, showOverlay])

  const refreshHistory = useCallback(async () => {
    const next = await window.ncc.tabHistory()
    setHistory(next)
    return next
  }, [])

  const openHistory = useCallback(() => {
    void refreshHistory()
    showOverlay('history')
  }, [refreshHistory, showOverlay])

  useEffect(() => {
    const offHistory = window.ncc.onOpenHistory(openHistory)
    const offDownloads = window.ncc.onOpenDownloads(() => showOverlay('downloads'))
    return () => {
      offHistory()
      offDownloads()
    }
  }, [openHistory, showOverlay])

  useEffect(() => {
    if (overlay !== 'history') return
    let alive = true
    void window.ncc.tabHistory().then((next) => {
      if (alive) setHistory(next)
    })
    return () => {
      alive = false
    }
  }, [overlay, state.url, state.activeTabId])

  useEffect(() => {
    setHint(state.failure?.code === 'invalid-address' ? state.failure.message : null)
  }, [state.failure])

  const navigate = useCallback((input: string) => {
    setHint(null)
    void window.ncc.navigate(input)
  }, [])

  const back = useCallback(() => void window.ncc.back(), [])
  const forward = useCallback(() => void window.ncc.forward(), [])
  // The toolbar's refresh action bypasses the HTTP cache; Ctrl+R remains a normal
  // reload, and Ctrl+Shift+R / the menu's Force reload use the same path as this.
  const reload = useCallback(() => void window.ncc.forceReload(), [])
  const stop = useCallback(() => void window.ncc.stop(), [])
  const toggleTor = useCallback(() => void window.ncc.toggleTor(), [])

  const newTab = useCallback(() => {
    setHint(null)
    void window.ncc.newTab().then(() => {
      window.dispatchEvent(new Event('ncc:focus-address'))
    })
  }, [])

  const closeTab = useCallback((id?: string) => {
    void window.ncc.closeTab(id)
  }, [])

  const selectTab = useCallback((id: string) => {
    void window.ncc.selectTab(id)
  }, [])

  const moveTab = useCallback((id: string, toIndex: number) => {
    void window.ncc.moveTab(id, toIndex)
  }, [])

  const toggleMute = useCallback((id: string) => {
    void window.ncc.toggleMute(id)
  }, [])

  const tabContextMenu = useCallback((id: string) => {
    void window.ncc.showTabMenu(id)
  }, [])

  const toggleBookmark = useCallback(() => {
    void window.ncc.toggleBookmark().then(setBookmarks)
  }, [])

  const removeBookmark = useCallback((url: string) => {
    void window.ncc.removeBookmark(url).then(setBookmarks)
  }, [])

  const openBookmark = useCallback(
    (url: string) => {
      closeOverlay()
      navigate(url)
    },
    [closeOverlay, navigate]
  )

  const selectHistory = useCallback(
    (index: number) => {
      closeOverlay()
      void window.ncc.goToHistoryIndex(index)
    },
    [closeOverlay]
  )

  const clearHistory = useCallback(() => {
    void window.ncc.clearHistory().then(refreshHistory)
  }, [refreshHistory])

  const cancelDownload = useCallback((id: string) => {
    void window.ncc.cancelDownload(id).then(setDownloads)
  }, [])

  const revealDownload = useCallback((id: string) => {
    void window.ncc.revealDownload(id)
  }, [])

  const clearDownloads = useCallback(() => {
    void window.ncc.clearDownloads().then(setDownloads)
  }, [])

  const runCommand = useCallback(
    (command: CommandId) => {
      closeOverlay()
      void window.ncc.runCommand(command)
    },
    [closeOverlay]
  )

  const respondToSigner = useCallback(
    (allow: boolean, remember: boolean) => {
      const request = signerRequest
      if (!request) return
      setSignerRequest(null)
      void window.ncc.respondToSigner(request.id, allow, remember)
    },
    [signerRequest]
  )

  useEffect(() => {
    // Escape stops a loading page from the chrome side; main handles it while the
    // remote page has focus, and dialogs close themselves with the same key.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && state.loading) {
        event.preventDefault()
        stop()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.loading, stop])

  const bookmarked = state.displayUrl !== '' && bookmarks.some((item) => item.url === state.displayUrl)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[color:var(--color-ink)]">
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        windowMaximized={state.windowMaximized}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
        onMove={moveTab}
        onContextMenu={tabContextMenu}
        onToggleMute={toggleMute}
        onOverflow={() => showOverlay('tabs')}
        onMinimize={() => void window.ncc.minimizeWindow()}
        onToggleMaximize={() => void window.ncc.toggleMaximizeWindow()}
        onCloseWindow={() => void window.ncc.closeWindow()}
      />

      <Toolbar
        state={state}
        hint={hint}
        identity={identity}
        signerPending={signerRequest !== null}
        bookmarked={bookmarked}
        downloads={downloads}
        onNavigate={navigate}
        onBack={back}
        onForward={forward}
        onReload={reload}
        onStop={stop}
        onToggleBookmark={toggleBookmark}
        onToggleTor={toggleTor}
        onOpenDownloads={() => showOverlay('downloads')}
        onOpenHistory={openHistory}
        onHistoryMenu={(direction) => void window.ncc.showHistoryMenu(direction)}
        onOpenSiteInfo={(anchor) => {
          setSiteInfoAnchor(anchor)
          showOverlay('site-info')
        }}
        onOpenSettings={() => openSettings('identity')}
        onOpenMenu={() => showOverlay('menu')}
      />

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {overlay === 'settings' ? (
          <SettingsPage
            open
            initialSection={settingsSection}
            onClose={closeOverlay}
            onIdentityChange={setIdentity}
          />
        ) : state.mode === 'blank' ? (
          <Welcome onOpenSettings={() => openSettings('general')} />
        ) : null}
      </main>

      {overlay === 'menu' ? (
        <ChromeMenu
          state={state}
          identity={identity}
          bookmarks={bookmarks}
          onCommand={runCommand}
          onOpenBookmark={openBookmark}
          onRemoveBookmark={removeBookmark}
          onClose={closeOverlay}
        />
      ) : null}

      {overlay === 'downloads' ? (
        <DownloadsPanel
          downloads={downloads}
          onClose={closeOverlay}
          onCancel={cancelDownload}
          onReveal={revealDownload}
          onClear={clearDownloads}
        />
      ) : null}

      {overlay === 'history' ? (
        <HistoryPanel
          history={history}
          onClose={closeOverlay}
          onSelect={selectHistory}
          onClear={clearHistory}
        />
      ) : null}

      {overlay === 'site-info' ? (
        <SiteInfoPanel
          state={state}
          anchorRect={siteInfoAnchor}
          onClose={closeOverlay}
          onOpenSettings={() => openSettings('general')}
          onReload={() => {
            closeOverlay()
            reload()
          }}
        />
      ) : null}

      {overlay === 'tabs' ? (
        <TabOverflowMenu
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          onSelect={(id) => {
            closeOverlay()
            selectTab(id)
          }}
          onCloseTab={closeTab}
          onNewTab={() => {
            closeOverlay()
            newTab()
          }}
          onClose={closeOverlay}
        />
      ) : null}

      {signerRequest ? (
        <SignerPrompt request={signerRequest} onRespond={respondToSigner} />
      ) : null}
    </div>
  )
}
