import { useCallback, useEffect, useState } from 'react'
import { CreditCard, LockKeyhole, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { PasswordVaultStatus } from '@shared/passwords'
import type {
  PaymentCardDraft,
  PaymentCardSettingsStatus,
  PaymentCardSummary
} from '@shared/payment-cards'

const EMPTY: PaymentCardDraft = { name: '', number: '', expMonth: '', expYear: '', nickname: '' }

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
    return () => { offPasswords(); offCards() }
  }, [refresh])

  const openEdit = (card: PaymentCardSummary) => {
    setEditId(card.id)
    setDraft({ id: card.id, name: card.name, number: '', expMonth: card.expMonth, expYear: card.expYear, nickname: card.nickname })
  }
  const save = async () => {
    if (!draft) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await window.ncc.paymentCardsSave(draft)
      if (!result.ok) { setError(result.error ?? 'Could not save card'); return }
      setDraft(null); setEditId(undefined); await refresh()
      setNotice(result.pending ? 'Saved locally. Relay sync will retry.' : 'Card saved.')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    if (removeId !== id) { setRemoveId(id); return }
    setBusy(true); setError(null)
    try {
      const result = await window.ncc.paymentCardsRemove(id)
      if (!result.ok) { setError(result.error ?? 'Could not remove card'); return }
      setRemoveId(null); await refresh(); setNotice('Card removed.')
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }
  const config = async (patch: { fillPaymentCards?: boolean; offerPaymentCardSave?: boolean; savePaymentCardSecurityCodes?: boolean; allowNostrPaymentCardAuth?: boolean; defaultNostrPaymentCardAuth?: boolean }) => {
    try { await window.ncc.passwordsSetConfig(patch); await refresh() }
    catch (reason) { await refresh().catch(() => undefined); setError(messageOf(reason)) }
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-ui-12 font-semibold text-[color:var(--color-text-strong)]"><CreditCard className="h-4 w-4" /> Payment methods</h3>
          <p className="mt-1 text-ui-11 leading-relaxed text-[color:var(--color-muted)]">Cards sync as a separate NIP-44 encrypted record. Security codes are off unless you opt in below.</p>
        </div>
        {cardStatus?.unlocked ? <button type="button" onClick={() => { setDraft({ ...EMPTY }); setEditId(undefined) }} className="inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)]"><Plus className="h-3.5 w-3.5" /> Add card</button> : null}
      </div>
      {!passwords?.unlocked || !cardStatus?.unlocked ? (
        <div className="mt-3 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3 text-ui-11 text-[color:var(--color-muted)]"><LockKeyhole className="mr-1 inline h-3.5 w-3.5" /> Unlock the password manager to manage payment cards.</div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-ui-11 text-[color:var(--color-text)]">
            <label className="flex items-center gap-2"><input type="checkbox" checked={cardStatus.enabled} onChange={(e) => void config({ fillPaymentCards: e.target.checked })} /> Offer card autofill</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={cardStatus.offerSave} onChange={(e) => void config({ offerPaymentCardSave: e.target.checked })} /> Ask to save cards after checkout</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={cardStatus.saveSecurityCodes} onChange={(e) => void config({ savePaymentCardSecurityCodes: e.target.checked })} /> Ask to save and autofill security codes (CVC/CVV)</label>
          </div>
          {cardStatus.saveSecurityCodes ? <p className="mt-2 text-ui-105 text-[color:var(--color-muted)]">When enabled, a checkout save prompt can include the security code. Turning this off removes saved codes from your encrypted card vault.</p> : null}
          <div className="mt-3 space-y-2 border-t border-[color:var(--color-line)] pt-3 text-ui-11 text-[color:var(--color-text)]">
            <label className="flex items-start gap-2"><input className="mt-0.5" type="checkbox" checked={cardStatus.allowNostrAuth} onChange={(e) => void config({ allowNostrPaymentCardAuth: e.target.checked })} /> <span>Allow Nostr signer confirmation for card fills</span></label>
            <label className="flex items-start gap-2"><input className="mt-0.5" type="checkbox" checked={cardStatus.defaultNostrAuth} onChange={(e) => void config({ allowNostrPaymentCardAuth: e.target.checked || cardStatus.allowNostrAuth, defaultNostrPaymentCardAuth: e.target.checked })} /> <span>Make Nostr signer the default confirmation method <span className="text-ui-105 text-[color:var(--color-muted)]">Selecting this also enables Nostr confirmation.</span></span></label>
            {cardStatus.allowNostrAuth ? <p className="text-ui-105 text-[color:var(--color-muted)]">Nostr confirmation is requested for each fill. When it is not the default, choose between it and system authentication each time.</p> : null}
            {cardStatus.allowNostrAuth && !cardStatus.nostrAuthAvailable ? <p className="text-ui-105 text-[color:var(--color-warn)]">Connect or unlock a Nostr signer before using Nostr confirmation.</p> : null}
            {!cardStatus.authAvailable && !cardStatus.allowNostrAuth ? <p className="text-ui-105 text-[color:var(--color-warn)]">System authentication is unavailable on this device. Enable Nostr confirmation to choose it for each fill or make it the default.</p> : null}
          </div>
          {cards.length ? <ul className="mt-3 divide-y divide-[color:var(--color-line)] rounded-lg border border-[color:var(--color-line)]">
            {cards.map((card) => <li key={card.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0"><p className="truncate text-ui-11 font-medium text-[color:var(--color-text-strong)]">{card.nickname || card.network} ···· {card.last4}</p><p className="text-ui-105 text-[color:var(--color-muted)]">{card.name || 'Cardholder'} · expires {card.expMonth}/{card.expYear}</p></div>
              <div className="flex gap-1"><button type="button" onClick={() => openEdit(card)} className="rounded px-2 py-1 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)]">Edit</button><button type="button" disabled={busy} onClick={() => void remove(card.id)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-ui-105 text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger)]/10"><Trash2 className="h-3 w-3" />{removeId === card.id ? 'Confirm' : 'Remove'}</button></div>
            </li>)}
          </ul> : <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-line)] px-3 py-5 text-center text-ui-11 text-[color:var(--color-muted)]">No payment cards saved.</p>}
          <button type="button" disabled={busy} onClick={() => void window.ncc.paymentCardsSync().then(refresh).catch((reason) => setError(messageOf(reason)))} className="mt-2 inline-flex items-center gap-1.5 rounded px-2 py-1 text-ui-105 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50"><RefreshCw className="h-3 w-3" /> Sync cards</button>
        </>
      )}
      {draft ? <div className="mt-3 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-field)] p-3">
        <p className="mb-2 text-ui-11 font-semibold text-[color:var(--color-text-strong)]">{editId ? 'Edit card details' : 'Add payment card'}</p>
        <div className="grid grid-cols-2 gap-2">
          {!editId ? <input inputMode="numeric" autoComplete="cc-number" value={draft.number} onChange={(e) => setDraft({ ...draft, number: e.target.value })} placeholder="Card number" className={fieldClass} /> : <p className="col-span-2 text-ui-105 text-[color:var(--color-muted)]">Card number ending in {cards.find((card) => card.id === editId)?.last4} is retained.</p>}
          <input autoComplete="cc-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Cardholder name" className={fieldClass} />
          <input value={draft.nickname} onChange={(e) => setDraft({ ...draft, nickname: e.target.value })} placeholder="Nickname (optional)" className={fieldClass} />
          <input inputMode="numeric" autoComplete="cc-exp-month" value={draft.expMonth} onChange={(e) => setDraft({ ...draft, expMonth: e.target.value })} placeholder="Month (MM)" className={fieldClass} />
          <input inputMode="numeric" autoComplete="cc-exp-year" value={draft.expYear} onChange={(e) => setDraft({ ...draft, expYear: e.target.value })} placeholder="Year (YY or YYYY)" className={fieldClass} />
        </div>
        <div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => { setDraft(null); setEditId(undefined) }} className="rounded px-2.5 py-1 text-ui-105 text-[color:var(--color-muted)]">Cancel</button><button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1 text-ui-105 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50">{busy ? 'Saving…' : 'Save card'}</button></div>
      </div> : null}
      {error ? <p className="mt-2 text-ui-105 text-[color:var(--color-danger)]">{error}</p> : null}
      {notice ? <p className="mt-2 text-ui-105 text-[color:var(--color-ok)]">{notice}</p> : null}
    </section>
  )
}

const fieldClass = 'min-w-0 rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-panel)] px-2.5 py-2 text-ui-11 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]/60'
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
