import { useCallback, useEffect, useState } from 'react'
import type { CommandId } from '@shared/commands'
import { InsecureWarning, SecurityBanner } from './components/SecurityNotice'
import { SettingsPage } from './components/SettingsPage'
import { WalletPanel } from './components/WalletPanel'
import { TabStrip } from './components/TabStrip'
import { AppPrompts } from './components/overlays/AppPrompts'
import { OverlayPanels } from './components/overlays/OverlayPanels'
import { Toolbar } from './components/Toolbar'
import { Welcome } from './components/Welcome'
import { useBrowserData } from './hooks/useBrowserData'
import { useOverlayController } from './hooks/useOverlayController'
import { usePasswordPrompts } from './hooks/usePasswordPrompts'
import { useSignerPrompts } from './hooks/useSignerPrompts'
import { normalizeHomeSite } from '@shared/home-sites'
import { listen } from '@tauri-apps/api/event'

export function App() {
  useEffect(() => {
    const content = (window as Window & { NccContent?: { notifySignerAccountsChanged?: (accounts: string) => void } }).NccContent
    if (!content?.notifySignerAccountsChanged) return
    let unlisten: (() => void) | undefined
    void listen<string[]>('ncc:signer-accounts-changed', (event) => {
      content.notifySignerAccountsChanged?.(JSON.stringify(event.payload))
    }).then((stop) => { unlisten = stop })
    return () => unlisten?.()
  }, [])

  const data = useBrowserData()
  const {
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
    extensions
  } = data

  const [hint, setHint] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false
    const check = async (): Promise<void> => {
      try {
        const version = await window.ncc.nccsearchCheckUpdate()
        if (!version || stopped || localStorage.getItem('nccsearch.dismissed-update') === version) return
        if (window.confirm(`nccsearch ${version} is available. Install it now?`)) {
          await window.ncc.nccsearchInstallUpdate(version)
          window.alert('nccsearch is updated. Restart Nostr Navigator to apply it.')
        } else {
          localStorage.setItem('nccsearch.dismissed-update', version)
        }
      } catch { /* update checks must not interrupt normal browsing */ }
    }
    let timer: number | undefined
    try {
      const last = Number(localStorage.getItem('nccsearch.last-update-check') || 0)
      if (Date.now() - last >= 86_400_000) {
        localStorage.setItem('nccsearch.last-update-check', String(Date.now()))
        void check()
      }
      timer = window.setInterval(() => {
        localStorage.setItem('nccsearch.last-update-check', String(Date.now()))
        void check()
      }, 86_400_000)
    } catch { /* storage may be unavailable */ }
    return () => { stopped = true; if (timer) window.clearInterval(timer) }
  }, [])

  const overlayController = useOverlayController({ refreshHistory, setIdentity })
  const {
    overlay,
    showOverlay,
    closeOverlay,
    settingsSection,
    openSettings,
    hostingDraft,
    setHostingDraft,
    siteInfoAnchor,
    setSiteInfoAnchor,
    identityChooserProfiles,
    identityChooserAnchor,
    identityChooserBusy,
    identityChooserError,
    openIdentityChooser,
    selectIdentity: selectToolbarIdentity
  } = overlayController

  const passwords = usePasswordPrompts({
    showOverlay,
    closeOverlay,
    overlayRef: overlayController.overlayRef,
    url: state.url,
    activeTabId: state.activeTabId,
    openSettings
  })
  const {
    passwordStatus,
    passwordContext,
    passwordAnchor,
    passwordBusy,
    passwordError,
    passwordSave,
    passwordSaveBusy,
    passwordSaveError,
    paymentCardSave,
    paymentCardSaveBusy,
    paymentCardSaveError,
    passwordDraftOrigin,
    passwordToast,
    clearPasswordDraftOrigin,
    openPasswords,
    unlockPasswords,
    lockPasswords,
    fillPassword,
    copyPassword,
    openPasswordSettings,
    respondToPasswordSave,
    respondToPaymentCardSave
  } = passwords

  const signer = useSignerPrompts({
    showOverlay,
    closeOverlay,
    overlayRef: overlayController.overlayRef
  })
  const {
    signerRequest,
    signerWaiting,
    passkeyConfirmation,
    respondToSigner,
    respondToPasskeyConfirmation
  } = signer

  useEffect(() => {
    if (overlay !== 'history') return
    void refreshHistory()
  }, [overlay, state.url, state.activeTabId, refreshHistory])

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
  }, [setBookmarks])

  const removeBookmark = useCallback(
    (url: string) => {
      void window.ncc.removeBookmark(url).then(setBookmarks)
    },
    [setBookmarks]
  )

  const addHomeSite = useCallback(() => {
    const site = normalizeHomeSite({
      url: state.displayUrl,
      title: state.title || state.displayUrl,
      icon: state.tabs.find((tab) => tab.id === state.activeTabId)?.favicon ?? undefined
    })
    if (!site || state.tabKind !== 'normal') return
    try {
      const stored = JSON.parse(localStorage.getItem('ncc.home-sites') || '[]') as unknown[]
      const entries = stored.map(normalizeHomeSite).filter((entry) => entry !== null)
      localStorage.setItem('ncc.home-sites', JSON.stringify([site, ...entries.filter((entry) => entry.url !== site.url)].slice(0, 40)))
      window.dispatchEvent(new Event('ncc:home-sites-changed'))
    } catch {
      setHint('Could not save this home screen shortcut.')
      closeOverlay()
      return
    }
    void window.ncc.createHomeShortcut(site).then((result) => {
      if (!result.ok) setHint(result.error ?? 'Could not create the desktop shortcut.')
      else setHint('Added to the home screen and desktop.')
    }).catch(() => setHint('The site was saved in NCC Browser, but the desktop shortcut could not be created.'))
    closeOverlay()
  }, [closeOverlay, state.activeTabId, state.displayUrl, state.tabKind, state.tabs, state.title])

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

  const cancelDownload = useCallback(
    (id: string) => {
      void window.ncc.cancelDownload(id).then(setDownloads)
    },
    [setDownloads]
  )

  const revealDownload = useCallback((id: string) => {
    void window.ncc.revealDownload(id)
  }, [])

  const clearDownloads = useCallback(() => {
    void window.ncc.clearDownloads().then(setDownloads)
  }, [setDownloads])

  const runCommand = useCallback(
    (command: CommandId) => {
      closeOverlay()
      void window.ncc.runCommand(command)
    },
    [closeOverlay]
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

  const openHistory = useCallback(() => {
    void refreshHistory()
    showOverlay('history')
  }, [refreshHistory, showOverlay])

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
            onPasswordDraftUsed={() => clearPasswordDraftOrigin()}
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

      <OverlayPanels
        overlay={overlay}
        state={state}
        identity={identity}
        bookmarks={bookmarks}
        syncDevices={syncDevices}
        downloads={downloads}
        history={history}
        passwordContext={passwordContext}
        passwordAnchor={passwordAnchor}
        passwordBusy={passwordBusy}
        passwordError={passwordError}
        siteInfoAnchor={siteInfoAnchor}
        identityChooserProfiles={identityChooserProfiles}
        identityChooserAnchor={identityChooserAnchor}
        identityChooserBusy={identityChooserBusy}
        identityChooserError={identityChooserError}
        onClose={closeOverlay}
        onOpenWallet={() => showOverlay('wallet')}
        onOpenSettings={() => openSettings('general')}
        onCommand={runCommand}
        onPublishService={(url) => {
          setHostingDraft({
            title: state.title && state.title !== 'New tab' ? state.title : 'My service',
            endpoints: [url]
          })
          openSettings('services')
        }}
        onAddHomeSite={addHomeSite}
        onOpenBookmark={openBookmark}
        onRemoveBookmark={removeBookmark}
        onOpenDeviceTab={(url) => {
          closeOverlay()
          void window.ncc.syncOpenTab(url)
        }}
        onCancelDownload={cancelDownload}
        onRevealDownload={revealDownload}
        onClearDownloads={clearDownloads}
        onSelectIdentity={(id) => void selectToolbarIdentity(id)}
        onSelectHistory={selectHistory}
        onClearHistory={clearHistory}
        onUnlockPasswords={() => void unlockPasswords()}
        onLockPasswords={() => void lockPasswords()}
        onFillPassword={(id) => void fillPassword(id)}
        onCopyPassword={(id, field) => void copyPassword(id, field)}
        onAddPassword={() => openPasswordSettings(passwordContext?.origin ?? null)}
        onManagePasswords={() => openPasswordSettings()}
        onReload={() => {
          closeOverlay()
          reload()
        }}
        onSelectTab={(id) => {
          closeOverlay()
          selectTab(id)
        }}
        onCloseTab={closeTab}
        onNewTab={() => {
          closeOverlay()
          newTab()
        }}
      />

      <AppPrompts
        signerRequest={signerRequest}
        signerWaiting={signerWaiting}
        onRespondToSigner={respondToSigner}
        passwordSave={passwordSave}
        passwordSaveBusy={passwordSaveBusy}
        passwordSaveError={passwordSaveError}
        onRespondToPasswordSave={(action) => void respondToPasswordSave(action)}
        paymentCardSave={paymentCardSave}
        paymentCardSaveBusy={paymentCardSaveBusy}
        paymentCardSaveError={paymentCardSaveError}
        onRespondToPaymentCardSave={(action) => void respondToPaymentCardSave(action)}
        passkeyConfirmation={passkeyConfirmation}
        onRespondToPasskeyConfirmation={respondToPasskeyConfirmation}
        passwordToast={passwordToast}
      />
    </div>
  )
}
