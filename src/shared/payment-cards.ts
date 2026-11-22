/* ------------------------------------------------------------------ */
/*  Data model                                                        */
/* ------------------------------------------------------------------ */

export interface PaymentCard {
  id: string
  name: string
  number: string
  /** Optional security code; only populated when the user opts in. */
  cvc?: string
  expMonth: string
  expYear: string
  nickname: string
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

export interface PaymentCardDraft {
  id?: string
  name: string
  number: string
  cvc?: string
  expMonth: string
  expYear: string
  nickname: string
}

export interface PaymentCardSummary {
  id: string
  name: string
  last4: string
  network: string
  expMonth: string
  expYear: string
  nickname: string
}

export interface PaymentCardSettingsStatus {
  unlocked: boolean
  authAvailable: boolean
  nostrAuthAvailable: boolean
  allowNostrAuth: boolean
  defaultNostrAuth: boolean
  enabled: boolean
  offerSave: boolean
  saveSecurityCodes: boolean
  cards: PaymentCardSummary[]
}

export interface PaymentCardSaveRequest {
  id: string
  mode: 'create' | 'update'
  name: string
  last4: string
  network: string
  expMonth: string
  expYear: string
  includesSecurityCode?: boolean
}

export interface PaymentCardSaveResult {
  ok: boolean
  error?: string
  pending?: boolean
}

export const PAYMENT_CARDS_D = 'ncc-browser/payment-cards/v1'
export const PAYMENT_CARDS_TAG = 'ncc-browser/payment-cards'
export const PAYMENT_CARDS_VERSION = 1
export const MAX_PAYMENT_CARDS = 100
export const MAX_PAYMENT_CARD_RECORDS = 200
export const MAX_PAYMENT_CARDS_BYTES = 40_000

export interface PaymentCardVault {
  v: typeof PAYMENT_CARDS_VERSION
  updatedAt: number
  cards: PaymentCard[]
  tombstones: PaymentCardTombstone[]
}

export interface PaymentCardTombstone { id: string; deletedAt: number }

export function emptyPaymentCardVault(): PaymentCardVault {
  return { v: PAYMENT_CARDS_VERSION, updatedAt: 0, cards: [], tombstones: [] }
}

export function normalizePaymentCardVault(input: unknown): PaymentCardVault {
  const value = input && typeof input === 'object' ? input as Partial<PaymentCardVault> : {}
  const cards = Array.isArray(value.cards) ? value.cards : []
  const normalized: PaymentCard[] = []
  const tombstones: PaymentCardTombstone[] = Array.isArray((value as { tombstones?: unknown }).tombstones)
    ? ((value as { tombstones: unknown[] }).tombstones).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const item = entry as Partial<PaymentCardTombstone>
      return typeof item.id === 'string' && /^[a-f0-9]{16}$/.test(item.id)
        ? [{ id: item.id, deletedAt: finite(item.deletedAt) }]
        : []
    }) : []
  if (cards.length + tombstones.length > MAX_PAYMENT_CARD_RECORDS) throw new Error('The payment card vault contains too many records')
  for (const candidate of cards) {
    if (!candidate || typeof candidate !== 'object') continue
    const card = candidate as Partial<PaymentCard>
    const number = digits(card.number).slice(0, 19)
    if (typeof card.id !== 'string' || !/^[a-f0-9]{16}$/.test(card.id)) continue
    if (card.deleted === true) {
      tombstones.push({ id: card.id, deletedAt: finite(card.updatedAt) })
      continue
    }
    if (!validLuhn(number) || !card.expMonth || !card.expYear) continue
    normalized.push({
      id: card.id,
      name: text(card.name, 100),
      number,
      ...(typeof card.cvc === 'string' && /^\d{3,4}$/.test(card.cvc) ? { cvc: card.cvc } : {}),
      expMonth: text(card.expMonth, 2),
      expYear: text(card.expYear, 4),
      nickname: text(card.nickname, 80),
      createdAt: finite(card.createdAt),
      updatedAt: finite(card.updatedAt),
    })
  }
  const deleted = new Map<string, number>()
  for (const item of tombstones) deleted.set(item.id, Math.max(deleted.get(item.id) ?? 0, item.deletedAt))
  const active = normalized.filter((card) => !deleted.has(card.id))
  return {
    v: PAYMENT_CARDS_VERSION,
    updatedAt: finite(value.updatedAt),
    cards: active,
    tombstones: [...deleted].map(([id, deletedAt]) => ({ id, deletedAt }))
  }
}

export function normalizePaymentCardDraft(input: PaymentCardDraft, existing?: PaymentCard, now = Date.now()): PaymentCard {
  const number = digits(input.number).slice(0, 19)
  const month = String(input.expMonth ?? '').replace(/\D/g, '').slice(0, 2).padStart(2, '0')
  const year = String(input.expYear ?? '').replace(/\D/g, '').slice(-4)
  if (!validLuhn(number)) throw new Error('Enter a valid card number')
  if (!/^(0[1-9]|1[0-2])$/.test(month)) throw new Error('Enter a valid expiry month')
  if (!/^\d{2}$|^\d{4}$/.test(year)) throw new Error('Enter a valid expiry year')
  const numericYear = Number(year.length === 2 ? `20${year}` : year)
  const numericMonth = Number(month)
  const currentYear = new Date(now).getFullYear()
  const currentMonth = new Date(now).getMonth() + 1
  if (numericYear < currentYear || (numericYear === currentYear && numericMonth < currentMonth)) {
    throw new Error('This card has expired')
  }
  return {
    id: existing?.id ?? randomId(),
    name: text(input.name, 100),
    number,
    ...(typeof input.cvc === 'string' && /^\d{3,4}$/.test(input.cvc) ? { cvc: input.cvc } : existing?.cvc ? { cvc: existing.cvc } : {}),
    expMonth: month,
    expYear: year,
    nickname: text(input.nickname, 80),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
}

export function paymentCardSummary(card: PaymentCard): PaymentCardSummary {
  return {
    id: card.id,
    name: card.name,
    last4: card.number.slice(-4),
    network: paymentCardNetwork(card.number),
    expMonth: card.expMonth,
    expYear: card.expYear,
    nickname: card.nickname
  }
}

export function paymentCardNetwork(number: string): string {
  if (/^4/.test(number)) return 'Visa'
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(number)) return 'Mastercard'
  if (/^3[47]/.test(number)) return 'American Express'
  if (/^6(?:011|5)/.test(number)) return 'Discover'
  return 'Card'
}

export function validLuhn(value: string): boolean {
  if (!/^\d{12,19}$/.test(value)) return false
  let total = 0
  let double = false
  for (let i = value.length - 1; i >= 0; i--) {
    let digit = Number(value[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    total += digit
    double = !double
  }
  return total % 10 === 0
}

export function mergePaymentCardVaults(local: PaymentCardVault, remote: PaymentCardVault): PaymentCardVault {
  const deleted = new Set([...local.tombstones, ...remote.tombstones].map((item) => item.id))
  const byId = new Map<string, PaymentCard>()
  for (const card of [...remote.cards, ...local.cards]) {
    if (deleted.has(card.id)) continue
    const previous = byId.get(card.id)
    if (!previous || card.updatedAt >= previous.updatedAt) byId.set(card.id, card)
  }
  const tombstones = new Map<string, number>()
  for (const item of [...remote.tombstones, ...local.tombstones]) tombstones.set(item.id, Math.max(tombstones.get(item.id) ?? 0, item.deletedAt))
  return { v: PAYMENT_CARDS_VERSION, updatedAt: Math.max(local.updatedAt, remote.updatedAt), cards: [...byId.values()].slice(-MAX_PAYMENT_CARDS), tombstones: [...tombstones].map(([id, deletedAt]) => ({ id, deletedAt })) }
}

function digits(value: unknown): string { return typeof value === 'string' ? value.replace(/\D/g, '') : '' }
function text(value: unknown, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0 }
function randomId(): string { return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('') }
