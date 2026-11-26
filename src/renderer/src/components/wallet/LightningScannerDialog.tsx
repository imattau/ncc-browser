import type { RefObject } from 'react'
import { Camera, X } from 'lucide-react'

interface LightningScannerDialogProps {
  open: boolean
  videoRef: RefObject<HTMLVideoElement | null>
  error: string
  currency?: string
  instruction?: string
  onClose: () => void
}

/** Camera preview for scanning a Lightning invoice. */
export function LightningScannerDialog({
  open,
  videoRef,
  error,
  currency = 'Lightning',
  instruction = 'Hold a Lightning invoice QR code in front of your camera.',
  onClose
}: LightningScannerDialogProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightning-scanner-title"
        className="wallet-dialog w-full max-w-md rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
              {currency}
            </p>
            <h2 id="lightning-scanner-title" className="mt-1 text-ui-16 font-semibold">
              Scan {currency} QR
            </h2>
          </div>
          <button
            className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]"
            aria-label="Close QR scanner"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
        </div>
        <p className="mt-3 text-ui-11 text-[color:var(--color-muted)]">
          <Camera className="mr-1 inline h-4 w-4" />
          {instruction}
        </p>
        {error ? (
          <p role="alert" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-ui-11">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <button
            className="rounded-lg border border-[color:var(--color-line)] px-4 py-2 text-ui-11"
            onClick={onClose}
          >
            Close scanner
          </button>
        </div>
      </div>
    </div>
  )
}
