import { describe, expect, it } from 'vitest'
import { mergePaymentCardVaults, normalizePaymentCardVault } from '../src/shared/payment-cards'

const card = {
  id: '0123456789abcdef',
  name: 'Test User',
  number: '4111111111111111',
  cvc: '987',
  expMonth: '12',
  expYear: '2030',
  nickname: '',
  createdAt: 1,
  updatedAt: 10
}

describe('payment-card deletion records', () => {
  it('migrates legacy deleted card records to ID and timestamp only', () => {
    const vault = normalizePaymentCardVault({ v: 1, updatedAt: 20, cards: [{ ...card, deleted: true }] })
    expect(vault.cards).toEqual([])
    expect(vault.tombstones).toEqual([{ id: card.id, deletedAt: card.updatedAt }])
    expect(JSON.stringify(vault)).not.toContain(card.number)
    expect(JSON.stringify(vault)).not.toContain(card.cvc)
  })

  it('removes card fields when creating a deletion tombstone', () => {
    const vault = normalizePaymentCardVault({ v: 1, updatedAt: 10, cards: [card] })
    const deleted = normalizePaymentCardVault({
      v: 1,
      updatedAt: 20,
      cards: [],
      tombstones: [{ id: card.id, deletedAt: 20 }]
    })
    const merged = mergePaymentCardVaults(vault, deleted)
    expect(merged.cards).toEqual([])
    expect(merged.tombstones).toEqual([{ id: card.id, deletedAt: 20 }])
  })

  it('does not restore a deleted card from a stale synced copy', () => {
    const oldCopy = normalizePaymentCardVault({ v: 1, updatedAt: 10, cards: [card] })
    const deletion = normalizePaymentCardVault({
      v: 1,
      updatedAt: 20,
      cards: [],
      tombstones: [{ id: card.id, deletedAt: 20 }]
    })
    expect(mergePaymentCardVaults(deletion, oldCopy).cards).toEqual([])
    expect(mergePaymentCardVaults(oldCopy, deletion).cards).toEqual([])
  })
})
