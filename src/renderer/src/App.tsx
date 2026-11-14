import { useCallback, useEffect, useRef, useState } from 'react'
import type { DownloadNotice, IdentityStatus, NavState, SignerRequest } from '@shared/types'
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
  const [hint, setHint] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<DownloadNotice[]>([])
  const [identity, setIdentity] = useState<IdentityStatus | null>(null)
  const [signerRequest, setSignerRequest] = useState<SignerRequest | null>(null)
  const downloadTimers = useRef(new Map<string, number>())

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
    const offRequest = window.ncc.onSignerRequest((request) => setSignerRequest(request))
    const offResolved = window.ncc.onSignerResolved((id) =>
      setSignerRequest((current) => (current?.id === id ? null : current))
    )
    return () => {
      offRequest()
      offResolved()
    }
  }, [])

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
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey

      if (modifier && event.key.toLowerCase() === 't') {
        event.preventDefault()
        newTab()
        return
      }
      if (modifier && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        closeTab()
        return
      }
      if (modifier && event.key === 'Tab') {
        event.preventDefault()
        const tabs = state.tabs
        if (tabs.length < 2) return
        const index = tabs.findIndex((tab) => tab.id === state.activeTabId)
        const next = event.shiftKey
          ? tabs[(index - 1 + tabs.length) % tabs.length]
          : tabs[(index + 1) % tabs.length]
        if (next) selectTab(next.id)
        return
      }
      if (modifier && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        reload()
        return
      }
      if (event.key === 'Escape' && state.loading) {
        event.preventDefault()
        stop()
        return
      }
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        back()
        return
      }
      if (event.altKey && event.key === 'ArrowRight') {
        event.preventDefault()
        forward()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    back,
    closeTab,
    forward,
    newTab,
    reload,
    selectTab,
    state.activeTabId,
    state.loading,
    state.tabs,
    stop
  ])

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
      />

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {state.mode === 'blank' ? <Welcome onOpenSettings={() => setSettingsOpen(true)} /> : null}
      </main>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onIdentityChange={setIdentity}
      />

      {signerRequest ? (
        <SignerPrompt request={signerRequest} onRespond={respondToSigner} />
      ) : null}
    </div>
  )
}
