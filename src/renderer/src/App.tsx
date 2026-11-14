import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommandId } from '@shared/commands'
import type { DownloadNotice, IdentityStatus, NavState, SignerRequest } from '@shared/types'
import { ChromeMenu } from './components/ChromeMenu'
import { SettingsDialog } from './components/SettingsDialog'
import { SignerPrompt } from './components/SignerPrompt'
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
  tabs: [],
  activeTabId: null
}

export function App() {
  const [state, setState] = useState<NavState>(EMPTY_STATE)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<DownloadNotice[]>([])
  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [signerRequest, setSignerRequest] = useState<SignerRequest | null>(null)
  const downloadTimers = useRef(new Map<string, number>())

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    void window.ncc.setOverlay('menu', false)
  }, [])

  const openMenu = useCallback(() => {
    setMenuOpen(true)
    void window.ncc.setOverlay('menu', true)
  }, [])

  const runCommand = useCallback(
    (command: CommandId) => {
      closeMenu()
      void window.ncc.runCommand(command)
    },
    [closeMenu]
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
    const unsubscribe = window.ncc.onSignerRequest((request) => {
      closeMenu()
      setSignerRequest(request)
    })
    const offResolved = window.ncc.onSignerResolved((id) =>
      setSignerRequest((current) => (current?.id === id ? null : current))
    )
    return () => {
      unsubscribe()
      offResolved()
    }
  }, [closeMenu])

  useEffect(() => {
    const offOpen = window.ncc.onOpenSettings(() => {
      closeMenu()
      setSettingsOpen(true)
    })
    const offClose = window.ncc.onCloseMenu(closeMenu)
    return () => {
      offOpen()
      offClose()
    }
  }, [closeMenu])

  useEffect(() => {
    const unsubscribe = window.ncc.onDownload((notice) => {
      setDownloads((current) => [...current.filter((item) => item.id !== notice.id), notice])

      const existing = downloadTimers.current.get(notice.id)
      if (existing) window.clearTimeout(existing)

      if (notice.state !== 'started') {
        const timer = window.setTimeout(() => {
          setDownloads((current) => current.filter((item) => item.id !== notice.id))
          downloadTimers.current.delete(notice.id)
        }, 4000)
        downloadTimers.current.set(notice.id, timer)
      }
    })

    return () => {
      unsubscribe()
      for (const timer of downloadTimers.current.values()) window.clearTimeout(timer)
      downloadTimers.current.clear()
    }
  }, [])

  useEffect(() => {
    setHint(state.failure?.code === 'invalid-address' ? state.failure.message : null)
  }, [state.failure])

  const navigate = useCallback((input: string) => {
    setHint(null)
    void window.ncc.navigate(input)
  }, [])

  const back = useCallback(() => void window.ncc.back(), [])
  const forward = useCallback(() => void window.ncc.forward(), [])
  const reload = useCallback(() => void window.ncc.reload(), [])
  const stop = useCallback(() => void window.ncc.stop(), [])

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
    // Global shortcuts (Ctrl+L/T/W/R, Alt+←/→, Ctrl+Tab) live in the application menu
    // so they keep working while the remote page has focus. Escape is the one key that
    // cannot be a menu accelerator; the content view handles it in main, this covers
    // the case where the chrome itself has focus.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && state.loading) {
        event.preventDefault()
        stop()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state.loading, stop])

  return (
    <div className="flex h-full flex-col bg-[color:var(--color-ink)]">
      <TabStrip
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        downloads={downloads}
        onSelect={selectTab}
        onClose={closeTab}
        onNew={newTab}
      />

      <Toolbar
        state={state}
        hint={hint}
        identity={identity}
        signerPending={signerRequest !== null}
        onNavigate={navigate}
        onBack={back}
        onForward={forward}
        onReload={reload}
        onStop={stop}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenMenu={openMenu}
      />

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {state.mode === 'blank' ? <Welcome onOpenSettings={() => setSettingsOpen(true)} /> : null}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onIdentityChange={setIdentity}
      />

      {menuOpen ? (
        <ChromeMenu
          state={state}
          identity={identity}
          onCommand={runCommand}
          onClose={closeMenu}
        />
      ) : null}

      {signerRequest ? (
        <SignerPrompt request={signerRequest} onRespond={respondToSigner} />
      ) : null}
    </div>
  )
}
