import { useState } from 'react'
import { RefreshCw, X, Zap } from 'lucide-react'
import { BitcoinView } from './BitcoinView'
import { LightningView } from './LightningView'
import { MoneroWalletPanel } from './MoneroWalletPanel'
import type { WalletContext, WalletPanelProps } from './types'
import { useWalletData } from './useWalletData'

const CURRENCIES = ['BTC', 'XMR', 'LN'] as const

function currencyLabel(currency: (typeof CURRENCIES)[number]): string {
  if (currency === 'BTC') return 'Bitcoin'
  if (currency === 'XMR') return 'Monero'
  return 'Lightning'
}

/** Wallet shell: currency switch, shared status line and the three views. */
export function WalletPanel({ onClose, onOpenIdentitySettings }: WalletPanelProps) {
  const [currency, setCurrency] = useState<(typeof CURRENCIES)[number]>('BTC')
  const data = useWalletData()
  const wallet: WalletContext = { ...data, onOpenIdentitySettings }

  return (
    <section
      className="absolute inset-0 z-[80] overflow-y-auto bg-[color:var(--color-panel)] text-[color:var(--color-text-strong)]"
      aria-label="Wallet"
    >
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-5 py-4">
        <div>
          <p className="text-ui-10 font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
            Nostr Navigator
          </p>
          <h1 className="text-ui-18 font-semibold">Wallet</h1>
        </div>
        <div className="flex gap-2">
          <button
            className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]"
            title="Refresh"
            onClick={() => void data.refresh()}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            className="rounded-lg p-2 hover:bg-[color:var(--color-hover)]"
            aria-label="Close wallet"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-xl space-y-5 px-5 py-6">
        <nav
          className="mx-auto flex w-fit rounded-full border border-[color:var(--color-line)] p-1"
          aria-label="Wallet currency"
        >
          {CURRENCIES.map((item) => {
            const label = currencyLabel(item)
            const selected = currency === item
            return (
              <button
                key={item}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={selected}
                className={`grid h-10 w-10 place-items-center rounded-full text-ui-18 ${
                  selected
                    ? 'bg-[color:var(--color-hover)] text-[color:var(--color-text-strong)]'
                    : 'text-[color:var(--color-muted)]'
                }`}
                onClick={() => setCurrency(item)}
              >
                {item === 'BTC' ? (
                  <span aria-hidden="true">₿</span>
                ) : item === 'XMR' ? (
                  <span
                    aria-hidden="true"
                    className="grid h-6 w-6 place-items-center rounded-full border-2 border-[#f26822] text-ui-12 font-bold text-[#f26822]"
                  >
                    M
                  </span>
                ) : (
                  <Zap aria-hidden="true" className="h-5 w-5" />
                )}
              </button>
            )
          })}
        </nav>

        {currency === 'BTC' ? (
          <BitcoinView wallet={wallet} />
        ) : currency === 'XMR' ? (
          <MoneroWalletPanel onOpenIdentitySettings={onOpenIdentitySettings} />
        ) : (
          <LightningView wallet={wallet} />
        )}

        {data.message ? (
          <p role="status" className="rounded-lg border border-[color:var(--color-line)] p-3 text-ui-11">
            {data.message}
          </p>
        ) : null}
      </div>
    </section>
  )
}
