import { useEffect, useState } from 'react'
import { RotateCcw, X } from 'lucide-react'
import { DEFAULT_RELAYS } from '@shared/types'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [draft, setDraft] = useState('')
  const [gossip, setGossip] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setSaved(false)
    void window.ncc.getConfig().then((config) => {
      setDraft(config.relays.join('\n'))
      setGossip(config.gossip)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const save = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const relays = draft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    const relayResult = await window.ncc.setRelays(relays)
    if (!relayResult.ok) {
      setLoading(false)
      setError(relayResult.error ?? 'Could not save relays')
      return
    }

    const gossipResult = await window.ncc.setGossip(gossip)
    setLoading(false)
    if (!gossipResult.ok) {
      setError(gossipResult.error ?? 'Could not save gossip setting')
      return
    }

    const config = gossipResult.config ?? relayResult.config
    if (config) {
      setDraft(config.relays.join('\n'))
      setGossip(config.gossip)
    }
    setSaved(true)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-24 backdrop-blur-sm">
      <div className="ncc-fade-in w-full max-w-lg rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] shadow-[0_30px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-start justify-between border-b border-[color:var(--color-line)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Resolution relays</h2>
            <p className="mt-1 text-xs leading-relaxed text-[color:var(--color-muted)]">
              NCC-05 records are looked up on these relays. They see which npub you query, so
              keep the list small and intentional.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label htmlFor="relays" className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-muted)]">
            One relay per line
          </label>
          <textarea
            id="relays"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setSaved(false)
            }}
            spellCheck={false}
            rows={5}
            className="w-full resize-none rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-[#dfe3ea] outline-none focus:border-[color:var(--color-accent)]/60"
          />

          {error ? (
            <p className="mt-2 text-xs text-[color:var(--color-danger)]">{error}</p>
          ) : saved ? (
            <p className="mt-2 text-xs text-[color:var(--color-ok)]">
              Saved. The resolver and locator cache were cleared.
            </p>
          ) : (
            <p className="mt-2 text-xs text-[color:var(--color-muted)]">
              Defaults: {DEFAULT_RELAYS.join(', ')}
            </p>
          )}

          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-[color:var(--color-line)] bg-[#0e1016] p-3.5">
            <input
              type="checkbox"
              checked={gossip}
              onChange={(event) => {
                setGossip(event.target.checked)
                setSaved(false)
              }}
              className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
            />
            <span>
              <span className="block text-[12px] font-medium text-[#e7e9ef]">
                Follow NIP-65 relay hints
              </span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-[color:var(--color-muted)]">
                Ask the target identity&apos;s relay list where it actually publishes. More
                reliable, at the cost of one extra metadata lookup on the configured relays.
              </span>
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[color:var(--color-line)] px-5 py-3.5">
          <button
            type="button"
            onClick={() => {
              setDraft(DEFAULT_RELAYS.join('\n'))
              setSaved(false)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-[color:var(--color-muted)] hover:bg-white/5 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={loading}
              className="rounded-lg bg-[color:var(--color-accent)] px-3.5 py-1.5 text-xs font-semibold text-[#0b0c10] disabled:opacity-60"
            >
              {loading ? 'Saving…' : 'Save relays'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
