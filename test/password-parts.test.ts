import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isVaultIncomplete, splitVault, vaultPartD, vaultPartIndex } from '../src/shared/password-parts'
import { normalizeVault, vaultByteLength } from '../src/shared/passwords'

interface Spec { n: number; notes: number; deleted?: boolean; favorite?: boolean }
interface Case {
  name: string
  layout: Record<string, number[]>
  entries: Spec[]
  expected: Record<string, number[]>
  bytes: Record<string, number>
}

const { cases } = JSON.parse(
  readFileSync(new URL('./fixtures/password-parts-vectors.json', import.meta.url), 'utf8')
) as { cases: Case[] }

const id = (n: number): string => n.toString(16).padStart(16, '0')

describe('splitVault', () => {
  it.each(cases)('$name', (vector) => {
    const vault = normalizeVault({
      entries: vector.entries.map((spec) => ({
        id: id(spec.n),
        origin: 'https://example.com',
        title: 'Example',
        username: 'alice',
        password: 'secret',
        notes: 'x'.repeat(spec.notes),
        totp: '',
        createdAt: spec.n,
        updatedAt: spec.n,
        deleted: spec.deleted,
        favorite: spec.favorite
      }))
    })
    // Notes are clamped by normalisation; these cases need larger single entries.
    vault.entries.forEach((entry, index) => {
      if (!entry.deleted) entry.notes = 'x'.repeat(vector.entries[index].notes)
    })
    const layout = new Map(
      Object.entries(vector.layout).map(([index, ids]) => [Number(index), new Set(ids.map(id))])
    )
    const parts = splitVault(vault, layout)
    expect(
      Object.fromEntries([...parts].map(([index, part]) => [index, part.entries.map((e) => parseInt(e.id, 16))]))
    ).toEqual(vector.expected)
    expect(
      Object.fromEntries([...parts].map(([index, part]) => [index, vaultByteLength(part)]))
    ).toEqual(vector.bytes)
  })
})

describe('vault parts', () => {
  it('accepts only exact part tags', () => {
    expect(vaultPartD(0)).toBe('ncc-browser/passwords/v1')
    expect(vaultPartIndex([['d', vaultPartD(15)]])).toBe(15)
    for (const d of ['ncc-browser/passwords/v1/0', 'ncc-browser/passwords/v1/16', 'ncc-browser/passwords/v1/01']) {
      expect(vaultPartIndex([['d', d]])).toBeNull()
    }
  })

  it('knows when a part is missing', () => {
    expect(isVaultIncomplete(new Map(), 0)).toBe(false)
    expect(isVaultIncomplete(new Map([[0, new Set<string>()]]), 0)).toBe(false)
    expect(isVaultIncomplete(new Map([[0, new Set<string>()]]), 2)).toBe(true)
    expect(isVaultIncomplete(new Map([[1, new Set<string>()]]), 0)).toBe(true)
  })
})
