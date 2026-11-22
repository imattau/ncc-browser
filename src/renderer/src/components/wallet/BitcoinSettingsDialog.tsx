import { useEffect, useState } from 'react'
import type { WalletSettings } from './types'

interface BitcoinSettingsDialogProps {
  open: boolean
  settings: WalletSettings | null
  busy: boolean
  onSave: (esploraUrl: string) => Promise<boolean>
  onClose: () => void
}

/** Esplora endpoint and the privacy explanation. */
export function BitcoinSettingsDialog({
  open,
  settings,
  busy,
  onSave,
  onClose
}: BitcoinSettingsDialogProps) {
  const [endpoint, setEndpoint] = useState('')

  useEffect(() => {
    if (open) setEndpoint(settings?.esploraUrl ?? '')
  }, [open, settings])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5"
      >
        <h2 className="text-ui-15 font-semibold">Bitcoin data service</h2>
        <label className="mt-4 block text-ui-11">
          Esplora-compatible API
          <input
            className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] p-3 font-mono text-ui-10"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </label>
        <p className="mt-3 text-ui-10 text-[color:var(--color-muted)]">
          Public Esplora operators can associate your wallet address with your IP address. When
          Tor preference is enabled, NCC routes these requests through Tor.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            disabled={busy}
            className="rounded-lg bg-[color:var(--color-accent)] px-4 py-2 text-ui-11 text-white"
            onClick={() => void onSave(endpoint).then((ok) => (ok ? onClose() : undefined))}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
