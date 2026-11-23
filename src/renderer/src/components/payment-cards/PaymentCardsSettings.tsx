import { useCallback, useEffect, useState } from 'react'
import { CreditCard, LockKeyhole, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { PasswordVaultStatus } from '@shared/passwords'
import type {
  PaymentCardDraft,
  PaymentCardSettingsStatus,
  PaymentCardSummary
} from '@shared/payment-cards'
import { PaymentCardForm } from './PaymentCardForm'
import { PaymentCardPreferences } from './PaymentCardPreferences'
import { EMPTY_CARD, type PaymentCardConfigPatch } from './types'

/**
 * Payment card list, preferences and the add/edit form. This module keeps its own
 * error unwrapping on purpose: unlike `lib/format.messageOf`, it does not strip
 * Electron's "Error invoking remote method" prefix, and the visible text should not
 * change.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function PaymentCardsSettings({ passwords }: { passwords: PasswordVaultStatus | null }) {
  const [cards, setCards] = useState<PaymentCardSummary[]>([])
  const [cardStatus, setCardStatus] = useState<PaymentCardSettingsStatus | null>(null)
  const [draft, setDraft] = useState<PaymentCardDraft | null>(null)
  const [editId, setEditId] = useState<string | undefined>()
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const status = await window.ncc.paymentCardsStatus()
    setCardStatus(status)
    setCards(status.unlocked ? status.cards : [])
  }, [])

  useEffect(() => {
    void refresh().catch((reason) => setError(messageOf(reason)))
    const offPasswords = window.ncc.onPasswordStatus(() => void refresh().catch(() => undefined))
    const offCards = window.ncc.onPaymentCardsStatus((status) => {
      setCardStatus(status)
      setCards(status.unlocked ? status.cards : [])
    })
    return () => {
      offPasswords()
      offCards()
    }
  }, [refresh])

  const openEdit = (card: PaymentCardSummary) => {
    setEditId(card.id)
    setDraft({
      id: card.id,
      name: card.name,
      number: '',
      expMonth: card.expMonth,
      expYear: card.expYear,
      nickname: card.nickname
    })
  }

  const save = async () => {
    if (!draft) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.ncc.paymentCardsSave(draft)
      if (!result.ok) {
        setError(result.error ?? 'Could not save card')
        return
      }
      setDraft(null)
      setEditId(undefined)
      await refresh()
      setNotice(result.pending ? 'Saved locally. Relay sync will retry.' : 'Card saved.')
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (removeId !== id) {
      setRemoveId(id)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.paymentCardsRemove(id)
      if (!result.ok) {
        setError(result.error ?? 'Could not remove card')
        return
      }
      setRemoveId(null)
      await refresh()
      setNotice('Card removed.')
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  const config = async (patch: PaymentCardConfigPatch) => {
    try {
      await window.ncc.passwordsSetConfig(patch)
      await refresh()
    } catch (reason) {
      await refresh().catch(() => undefined)
      setError(messageOf(reason))
    }
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]">
            <CreditCard className="h-4 w-4" /> Payment methods
          </h3>
          <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">
            Cards sync as a separate NIP-44 encrypted record. Security codes are off unless you
            opt in below.
          </p>
        </div>
        {cardStatus?.unlocked ? (
          <button
            type="button"
            onClick={() => {
              setDraft({ ...EMPTY_CARD })
              setEditId(undefined)
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)]"
          >
            <Plus className="h-3.5 w-3.5" /> Add card
          </button>
        ) : null}
      </div>

      {!passwords?.unlocked || !cardStatus?.unlocked ? (
        <div className="mt-3 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3 text-ui-11 text-[color:var(--color-muted)]">
          <LockKeyhole className="mr-1 inline h-3.5 w-3.5" /> Unlock the password manager to
          manage payment cards.
        </div>
      ) : (
        <>
          <PaymentCardPreferences status={cardStatus} onConfig={(patch) => void config(patch)} />

          {cards.length ? (
            <ul className="mt-3 divide-y divide-[color:var(--color-line)] rounded-lg border border-[color:var(--color-line)]">
              {cards.map((card) => (
                <li
                  key={card.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-ui-11 font-medium text-[color:var(--color-text-strong)]">
                      {card.nickname || card.network} ···· {card.last4}
                    </p>
                    <p className="text-ui-105 text-[color:var(--color-muted)]">
                      {card.name || 'Cardholder'} · expires {card.expMonth}/{card.expYear}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(card)}
                      className="rounded px-2 py-1 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(card.id)}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-ui-105 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"
                    >
                      <Trash2 className="h-3 w-3" />
                      {removeId === card.id ? 'Confirm' : 'Remove'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-line)] px-3 py-5 text-center text-ui-11 text-[color:var(--color-muted)]">
              No payment cards saved.
            </p>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void window.ncc
                .paymentCardsSync()
                .then(refresh)
                .catch((reason) => setError(messageOf(reason)))
            }
            className="mt-2 inline-flex items-center gap-1.5 rounded px-2 py-1 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" /> Sync cards
          </button>
        </>
      )}

      {draft ? (
        <PaymentCardForm
          draft={draft}
          editId={editId}
          retainedLast4={cards.find((card) => card.id === editId)?.last4}
          busy={busy}
          onChange={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))}
          onCancel={() => {
            setDraft(null)
            setEditId(undefined)
          }}
          onSave={() => void save()}
        />
      ) : null}

      {error ? <p className="mt-2 text-ui-105 text-[color:var(--color-danger)]">{error}</p> : null}
      {notice ? <p className="mt-2 text-ui-105 text-[color:var(--color-ok)]">{notice}</p> : null}
    </section>
  )
}
