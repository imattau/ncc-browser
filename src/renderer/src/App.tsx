import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostingDraft } from '@shared/hosting'
import type { CommandId } from '@shared/commands'
import type { ExtensionActionInfo, ExtensionsState } from '@shared/extensions'
import { sortDownloads } from '@shared/downloads'
import type {
  Bookmark,
  AppConfig,
  DownloadNotice,
  IdentityProfile,
  IdentityStatus,
  NavState,
  OverlayReason,
  PasskeyConfirmationRequest,
  PasswordContext,
  PasswordSaveRequest,
  PasswordToast,
  PasswordVaultStatus,
  PaymentCardSaveRequest,
  SignerRequest,
  TabHistory
} from '@shared/types'
import { ChromeMenu } from './components/ChromeMenu'
import type { SyncDevice } from '@shared/sync-status'
import { DownloadsPanel } from './components/DownloadsPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { IdentityChooser } from './components/IdentityChooser'
import { PasswordsPanel } from './components/PasswordsPanel'
import { PasswordSavePrompt } from './components/PasswordSavePrompt'
import { PasskeyConfirmationPrompt } from './components/PasskeyConfirmationPrompt'
import { PaymentCardSavePrompt } from './components/PaymentCardSavePrompt'
import { type PopoverAnchor } from './components/Popover'
import { InsecureWarning, SecurityBanner } from './components/SecurityNotice'
import { SettingsPage, type SettingsSection } from './components/SettingsPage'
import { WalletPanel } from './components/WalletPanel'
import { SignerPrompt } from './components/SignerPrompt'
import { ShareNostrPanel } from './components/ShareNostrPanel'
import { SiteInfoPanel } from './components/SiteInfoPanel'
import { TabOverflowMenu } from './components/TabOverflowMenu'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'
import { applyAppearance } from './lib/appearance'
import { cn } from './lib/cn'
import { messageOf } from './lib/format'

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

export function App() {
  const [state, setState] = useState<NavState>(EMPTY_STATE)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [overlay, setOverlay] = useState<OverlayReason | null>(null)
  const overlayRef = useRef<OverlayReason | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<DownloadNotice[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [syncDevices, setSyncDevices] = useState<SyncDevice[]>([])
  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [identityChooserProfiles, setIdentityChooserProfiles] = useState<IdentityProfile[]>([])
  const [identityChooserAnchor, setIdentityChooserAnchor] = useState<PopoverAnchor | null>(null)
  const [identityChooserBusy, setIdentityChooserBusy] = useState(false)
  const [identityChooserError, setIdentityChooserError] = useState<string | null>(null)
  const [signerRequests, setSignerRequests] = useState<SignerRequest[]>([])
  const signerRequest = signerRequests[0] ?? null
  const [history, setHistory] = useState<TabHistory | null>(null)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const [hostingDraft, setHostingDraft] = useState<HostingDraft | null>(null)
  const [siteInfoAnchor, setSiteInfoAnchor] = useState<PopoverAnchor | null>(null)
  const [passwordStatus, setPasswordStatus] = useState<PasswordVaultStatus | null>(null)
  const [passwordContext, setPasswordContext] = useState<PasswordContext | null>(null)
  const [passwordAnchor, setPasswordAnchor] = useState<PopoverAnchor | null>(null)
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordSave, setPasswordSave] = useState<PasswordSaveRequest | null>(null)
  const [passwordSaveBusy, setPasswordSaveBusy] = useState(false)
  const [passwordSaveError, setPasswordSaveError] = useState<string | null>(null)
  const [paymentCardSave, setPaymentCardSave] = useState<PaymentCardSaveRequest | null>(null)
  const [paymentCardSaveBusy, setPaymentCardSaveBusy] = useState(false)
  const [paymentCardSaveError, setPaymentCardSaveError] = useState<string | null>(null)
  const [passkeyConfirmations, setPasskeyConfirmations] = useState<PasskeyConfirmationRequest[]>([])
  const passkeyConfirmation = passkeyConfirmations[0] ?? null
  const [passwordDraftOrigin, setPasswordDraftOrigin] = useState<string | null>(null)
  const [passwordToast, setPasswordToast] = useState<PasswordToast | null>(null)
  const [extensions, setExtensions] = useState<ExtensionsState | null>(null)

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

  const openIdentityChooser = useCallback(
    async (anchor: PopoverAnchor): Promise<void> => {
      try {
        const list = await window.ncc.identityList()
        if (list.identities.length > 1) {
          setIdentityChooserProfiles(list.identities)
          setIdentityChooserAnchor(anchor)
          setIdentityChooserError(null)
          showOverlay('identity-chooser')
        } else {
          openSettings('identity')
        }
      } catch {
        openSettings('identity')
      }
    },
    [openSettings, showOverlay]
  )

  const selectToolbarIdentity = useCallback(
    async (id: string): Promise<void> => {
      setIdentityChooserBusy(true)
      setIdentityChooserError(null)
      try {
        setIdentity(await window.ncc.identitySelect(id))
        closeOverlay()
      } catch (error) {
        setIdentityChooserError(error instanceof Error ? error.message : String(error))
      } finally {
        setIdentityChooserBusy(false)
      }
    },
    [closeOverlay]
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

  // Appearance can change from Settings or from a main-process push; both arrive
  // as a config update.
  useEffect(
    () =>
      window.ncc.onConfig((config) => {
        setConfig(config)
        applyAppearance(config.appearance)
      }),
    []
  )

  useEffect(() => {
    let alive = true
    void window.ncc.getConfig().then((next) => { if (alive) setConfig(next) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    void window.ncc.extensionsState().then(setExtensions).catch(() => undefined)
    return window.ncc.onExtensions(setExtensions)
  }, [])

  useEffect(() => {
    let alive = true
    void window.ncc.passwordsStatus().then((next) => {
      if (alive) setPasswordStatus(next)
    })
    void window.ncc.passwordsContext().then((next) => {
      if (alive) setPasswordContext(next)
    })
    const offStatus = window.ncc.onPasswordStatus(setPasswordStatus)
    const offContext = window.ncc.onPasswordContext(setPasswordContext)
    const offSave = window.ncc.onPasswordSaveRequest((request) => {
      setPasswordToast(null)
      setPasswordSave(request)
      setPasswordSaveError(null)
      setPasswordDraftOrigin(null)
      showOverlay('password-save')
    })
    const offCardSave = window.ncc.onPaymentCardSaveRequest((request) => {
      setPaymentCardSave(request)
      setPaymentCardSaveError(null)
      showOverlay('payment-card-save')
    })
    const offToast = window.ncc.onPasswordToast((toast) => setPasswordToast(toast))
    return () => {
      alive = false
      offStatus()
      offContext()
      offSave()
      offCardSave()
      offToast()
    }
  }, [showOverlay])

  useEffect(() => {
    const offRequest = window.ncc.onPasskeyConfirmation((request) => {
      setPasskeyConfirmations((current) =>
        current.some((item) => item.id === request.id) ? current : [...current, request]
      )
    })
    const offResolved = window.ncc.onPasskeyConfirmationResolved((id) => {
      setPasskeyConfirmations((current) => current.filter((item) => item.id !== id))
    })
    return () => {
      offRequest()
      offResolved()
    }
  }, [])

  useEffect(() => {
    if (passkeyConfirmation) showOverlay('passkey-confirmation')
    else if (overlayRef.current === 'passkey-confirmation') closeOverlay()
  }, [passkeyConfirmation, showOverlay, closeOverlay])

  const respondToPaymentCardSave = async (action: 'save' | 'dismiss'): Promise<void> => {
    if (!paymentCardSave) return
    setPaymentCardSaveBusy(true)
    setPaymentCardSaveError(null)
    try {
      const result = await window.ncc.paymentCardsRespond(paymentCardSave.id, action)
      if (!result.ok) { setPaymentCardSaveError(result.error ?? 'Could not save card'); return }
      setPaymentCardSave(null)
      showOverlay(null)
      if (result.pending) setPasswordToast({ tone: 'warn', message: 'Card saved locally; relay sync will retry.' })
    } catch (error) {
      setPaymentCardSaveError(messageOf(error))
    } finally { setPaymentCardSaveBusy(false) }
  }

  useEffect(() => {
    let alive = true
    void window.ncc.passwordsContext().then((next) => {
      if (alive) setPasswordContext(next)
    })
    return () => {
      alive = false
    }
  }, [state.url, state.activeTabId])

  useEffect(() => {
    if (overlayRef.current === 'passwords') showOverlay(null)
  }, [state.url, state.activeTabId, showOverlay])

  useEffect(() => {
    let alive = true
    void window.ncc.passwordsContext().then((next) => {
      if (alive) setPasswordContext(next)
    })
    return () => {
      alive = false
    }
  }, [passwordStatus?.unlocked, passwordStatus?.lastSyncedAt])

  useEffect(() => {
    if (!passwordToast) return
    const timer = window.setTimeout(() => setPasswordToast(null), 4_500)
    return () => window.clearTimeout(timer)
  }, [passwordToast])

  const refreshPasswords = useCallback(async (): Promise<void> => {
    const [status, context] = await Promise.all([
      window.ncc.passwordsStatus(),
      window.ncc.passwordsContext()
    ])
    setPasswordStatus(status)
    setPasswordContext(context)
  }, [])

  const openPasswords = useCallback(
    (anchor: PopoverAnchor) => {
      setPasswordAnchor(anchor)
      setPasswordError(null)
      void refreshPasswords()
      showOverlay('passwords')
    },
    [refreshPasswords, showOverlay]
  )

  const unlockPasswords = useCallback(async (): Promise<void> => {
    setPasswordBusy(true)
    setPasswordError(null)
    try {
      const status = await window.ncc.passwordsUnlock()
      setPasswordStatus(status)
      await refreshPasswords()
      if (status.error) setPasswordError(status.error)
    } catch (unlockError) {
      setPasswordError(messageOf(unlockError))
    } finally {
      setPasswordBusy(false)
    }
  }, [refreshPasswords])

  const lockPasswords = useCallback(async (): Promise<void> => {
    setPasswordStatus(await window.ncc.passwordsLock())
    await refreshPasswords()
  }, [refreshPasswords])

  const fillPassword = useCallback(
    async (id: string): Promise<void> => {
      closeOverlay()
      const result = await window.ncc.passwordsFill(id)
      if (!result.ok) setPasswordToast({ tone: 'error', message: result.error ?? 'Could not fill' })
      else setPasswordToast({ tone: 'ok', message: 'Login filled.' })
      await refreshPasswords()
    },
    [closeOverlay, refreshPasswords]
  )

  const copyPassword = useCallback(
    async (id: string, field: 'username' | 'password' | 'totp'): Promise<void> => {
      const result = await window.ncc.passwordsCopy(id, field)
      if (!result.ok) {
        setPasswordToast({ tone: 'error', message: result.error ?? 'Could not copy' })
        return
      }
      setPasswordToast({
        tone: 'ok',
        message: result.clearsAt
          ? 'Copied. The clipboard clears in 30 seconds.'
          : 'Username copied.'
      })
    },
    []
  )

  const openPasswordSettings = useCallback(
    (origin?: string | null) => {
      setPasswordAnchor(null)
      setPasswordDraftOrigin(origin ?? null)
      openSettings('passwords')
    },
    [openSettings]
  )

  const respondToPasswordSave = useCallback(
    async (action: 'save' | 'never' | 'dismiss'): Promise<void> => {
      const request = passwordSave
      if (!request) return
      setPasswordSaveBusy(true)
      setPasswordSaveError(null)
      try {
        const result = await window.ncc.passwordsRespond(request.id, action)
        if (!result.ok) {
          setPasswordSaveError(result.error ?? 'Could not save the login')
          return
        }
        setPasswordSave(null)
        closeOverlay()
        await refreshPasswords()
      } finally {
        setPasswordSaveBusy(false)
      }
    },
    [closeOverlay, passwordSave, refreshPasswords]
  )

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

  useEffect(() => {
    const remember = (request: SignerRequest): void => {
      showOverlay(null)
      setSignerRequests((current) =>
        current.some((entry) => entry.id === request.id) ? current : [...current, request]
      )
    }

    const unsubscribe = window.ncc.onSignerRequest(remember)
    const offResolved = window.ncc.onSignerResolved((id) =>
      setSignerRequests((current) => current.filter((entry) => entry.id !== id))
    )

    // A request raised before this renderer mounted was sent to nobody; the broker
    // keeps it pending, so replay whatever it still has.
    void window.ncc
      .pendingSignerRequests()
      .then((pending) => pending.forEach(remember))
      .catch(() => undefined)

    return () => {
      unsubscribe()
      offResolved()
    }
  }, [showOverlay])

  useEffect(() => {
    const offOpen = window.ncc.onOpenSettings((payload) =>
      openSettings(
        payload.section === 'identity' ||
          payload.section === 'appearance' ||
          payload.section === 'passwords' ||
          payload.section === 'services' ||
          payload.section === 'sites' ||
          payload.section === 'security' ||
          payload.section === 'trusted' ||
          payload.section === 'about'
          ? payload.section
          : 'general'
      )
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

  const newPrivateTab = useCallback(() => {
    setHint(null)
    void window.ncc.newPrivateTab().then(() => {
      window.dispatchEvent(new Event('ncc:focus-address'))
    })
  }, [])

  const newTorTab = useCallback(() => {
    setHint(null)
    void window.ncc.newTorTab().then(() => {
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
      if (!signerRequest) return
      setSignerRequests((current) => current.filter((entry) => entry.id !== signerRequest.id))
      void window.ncc.respondToSigner(signerRequest.id, allow, remember)
    },
    [signerRequest]
  )

  const respondToPasskeyConfirmation = useCallback((choice: number | null) => {
    if (!passkeyConfirmation) return
    const id = passkeyConfirmation.id
    setPasskeyConfirmations((current) => current.filter((item) => item.id !== id))
    void window.ncc.respondToPasskeyConfirmation(id, choice)
  }, [passkeyConfirmation])

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
    <div
      data-window-kind={state.tabKind}
      className="flex h-full flex-col overflow-hidden bg-[color:var(--color-ink)]"
    >
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        windowMaximized={state.windowMaximized}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
        onNewMenu={() => void window.ncc.showNewTabMenu()}
        onMove={moveTab}
        onDetach={(id, screenX, screenY) => void window.ncc.detachTab(id, screenX, screenY)}
        onContextMenu={tabContextMenu}
        onToggleMute={toggleMute}
        onOverflow={() => showOverlay('tabs')}
        onMinimize={() => void window.ncc.minimizeWindow()}
        onToggleMaximize={() => void window.ncc.toggleMaximizeWindow()}
        onCloseWindow={() => void window.ncc.closeWindow()}
      />

      <Toolbar
        state={state}
        nccSearchEnabled={config?.nccSearchEnabled === true}
        onOpenNccSearch={() => navigate('nccsearch://app/')}
        hint={hint}
        identity={identity}
        signerPending={signerRequest !== null}
        bookmarked={bookmarked}
        downloads={downloads}
        passwordStatus={passwordStatus}
        passwordContext={passwordContext}
        extensionActions={extensions?.actions ?? []}
        onExtensionAction={(id, anchor) => void window.ncc.extensionsAction(id, anchor)}
        onNavigate={navigate}
        onBack={back}
        onForward={forward}
        onReload={reload}
        onStop={stop}
        onToggleBookmark={toggleBookmark}
        onToggleTor={toggleTor}
        onOpenDownloads={() => showOverlay('downloads')}
        onOpenHistory={openHistory}
        onOpenPasswords={openPasswords}
        onHistoryMenu={(direction) => void window.ncc.showHistoryMenu(direction)}
        onOpenSiteInfo={(anchor) => {
          setSiteInfoAnchor(anchor)
          showOverlay('site-info')
        }}
        onOpenIdentity={(anchor) => void openIdentityChooser(anchor)}
        onOpenMenu={() => showOverlay('menu')}
        onShareNostr={() => showOverlay('share-nostr')}
      />

      {state.banner && !state.insecurePrompt && !overlay ? (
        <SecurityBanner banner={state.banner} />
      ) : null}

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {state.insecurePrompt ? (
          <InsecureWarning
            prompt={state.insecurePrompt}
            onChoice={(choice) => void window.ncc.insecureChoice(choice)}
          />
        ) : overlay === 'settings' ? (
          <SettingsPage
            open
            initialSection={settingsSection}
            hostingDraft={hostingDraft}
            onHostingDraftUsed={() => setHostingDraft(null)}
            onClose={closeOverlay}
            onIdentityChange={setIdentity}
            passwordDraftOrigin={passwordDraftOrigin}
            onPasswordDraftUsed={() => setPasswordDraftOrigin(null)}
          />
        ) : overlay === 'wallet' ? (
          <WalletPanel onClose={closeOverlay} onOpenIdentitySettings={() => openSettings('identity')} />
        ) : state.mode === 'blank' ? (
          <Welcome
            onOpenSettings={() => openSettings('general')}
            onOpenServices={() => openSettings('services')}
            onNewPrivateTab={newPrivateTab}
            onNewTorTab={newTorTab}
            kind={state.tabKind}
          />
        ) : null}
      </main>

      {overlay === 'menu' ? (
        <ChromeMenu
          state={state}
          identity={identity}
          bookmarks={bookmarks}
          onCommand={runCommand}
          onOpenWallet={() => showOverlay('wallet')}
          onPublishService={(url) => {
            setHostingDraft({
              title: state.title && state.title !== 'New tab' ? state.title : 'My service',
              endpoints: [url]
            })
            openSettings('services')
          }}
          onOpenBookmark={openBookmark}
          onRemoveBookmark={removeBookmark}
          devices={syncDevices}
          onOpenDeviceTab={(url) => {
            closeOverlay()
            void window.ncc.syncOpenTab(url)
          }}
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

      {overlay === 'identity-chooser' ? (
        <IdentityChooser
          identities={identityChooserProfiles}
          anchor={identityChooserAnchor}
          busy={identityChooserBusy}
          error={identityChooserError}
          onClose={closeOverlay}
          onSelect={(id) => void selectToolbarIdentity(id)}
        />
      ) : null}

      {overlay === 'share-nostr' ? (
        <ShareNostrPanel
          title={state.title}
          url={state.displayUrl}
          npub={identity?.npub ?? ''}
          onClose={closeOverlay}
          onPost={(comment) => window.ncc.shareNostr(comment)}
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

      {overlay === 'passwords' ? (
        <PasswordsPanel
          context={passwordContext}
          anchor={passwordAnchor}
          busy={passwordBusy}
          error={passwordError}
          onClose={closeOverlay}
          onUnlock={() => void unlockPasswords()}
          onLock={() => void lockPasswords()}
          onFill={(id) => void fillPassword(id)}
          onCopy={(id, field) => void copyPassword(id, field)}
          onAdd={() => openPasswordSettings(passwordContext?.origin ?? null)}
          onManage={() => openPasswordSettings()}
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
        <SignerPrompt
          request={signerRequest}
          onRespond={respondToSigner}
          waiting={signerRequests.length - 1}
        />
      ) : null}

      {passwordSave ? (
        <PasswordSavePrompt
          request={passwordSave}
          busy={passwordSaveBusy}
          error={passwordSaveError}
          onRespond={(action) => void respondToPasswordSave(action)}
        />
      ) : null}

      {paymentCardSave ? (
        <PaymentCardSavePrompt
          request={paymentCardSave}
          busy={paymentCardSaveBusy}
          error={paymentCardSaveError}
          onRespond={(action) => void respondToPaymentCardSave(action)}
        />
      ) : null}

      {passkeyConfirmation ? (
        <PasskeyConfirmationPrompt
          request={passkeyConfirmation}
          onRespond={respondToPasskeyConfirmation}
        />
      ) : null}

      {passwordToast ? (
        <div
          className={cn(
            'fixed bottom-3 right-3 z-[110] max-w-sm rounded-xl border px-3 py-2 text-ui-11 shadow-lg',
            passwordToast.tone === 'error'
              ? 'border-[color:var(--color-danger)]/35 bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]'
              : passwordToast.tone === 'warn'
                ? 'border-[color:var(--color-warn)]/35 bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn)]'
                : 'border-[color:var(--color-ok)]/35 bg-[color:var(--color-ok)]/10 text-[color:var(--color-ok)]'
          )}
          role="status"
        >
          {passwordToast.message}
        </div>
      ) : null}
    </div>
  )
}
