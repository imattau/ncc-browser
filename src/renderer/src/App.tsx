import { useCallback, useEffect, useState } from 'react'
import type { NavState } from '@shared/types'
import { SettingsDialog } from './components/SettingsDialog'
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
  failure: null
}

export function App() {
  const [state, setState] = useState<NavState>(EMPTY_STATE)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [hint, setHint] = useState<string | null>(null)

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey

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
  }, [back, forward, reload, stop, state.loading])

  return (
    <div className="flex h-full flex-col bg-[color:var(--color-ink)]">
      <Toolbar
        state={state}
        hint={hint}
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

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
