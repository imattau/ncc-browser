import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isVaultIncomplete, planVault, splitVault, vaultPartD, vaultPartIndex } from '../src/shared/password-parts'
import { normalizeVault, vaultByteLength } from '../src/shared/passwords'

interface Spec { n: number; notes: number; deleted?: boolean; favorite?: boolean }
interface Case {
  name: string
  layout: Record<string, number[]>
  entries: Spec[]
  expected: Record<string, number[]>
  bytes: Record<string, number>
}

interface PlanCase {
  name: string
  layout: Record<string, number[]>
  saved: Record<string, Spec[]>
  entries: Spec[]
  next: number | null
  expected: Record<string, number[]>
  leaving: Record<string, number[]>
  full: boolean
}

const { cases, plans } = JSON.parse(
  readFileSync(new URL('./fixtures/password-parts-vectors.json', import.meta.url), 'utf8')
) as { cases: Case[]; plans: PlanCase[] }

const id = (n: number): string => n.toString(16).padStart(16, '0')

function build(specs: Spec[]) {
  const vault = normalizeVault({
    entries: specs.map((spec) => ({
      id: id(spec.n),
      origin: 'https://example.com',
      title: 'Example',
      username: 'alice',
      password: 'secret',
      notes: '',
      totp: '',
      createdAt: spec.n,
      updatedAt: spec.n,
      deleted: spec.deleted,
      favorite: spec.favorite
    }))
  })
  // Set after normalising, which clamps notes below what these cases need.
  vault.entries.forEach((entry, index) => {
    if (!entry.deleted) entry.notes = 'x'.repeat(specs[index].notes)
  })
  return vault
}

const numbers = (ids: Iterable<string>): number[] => [...ids].map((value) => parseInt(value, 16))

describe('planVault', () => {
  it.each(plans)('$name', (vector) => {
    const layout = new Map(
      Object.entries(vector.layout).map(([index, ids]) => [Number(index), new Set(ids.map(id))])
    )
    const saved = new Map(
      Object.entries(vector.saved).map(([index, specs]) => [Number(index), build(specs)])
    )
    const plan = planVault(build(vector.entries), layout, saved, vector.next)
    expect(
      Object.fromEntries([...plan.parts].map(([i, part]) => [i, numbers(part.entries.map((e) => e.id))]))
    ).toEqual(vector.expected)
    expect(
      Object.fromEntries([...plan.leaving].map(([i, ids]) => [i, numbers(ids)]))
    ).toEqual(vector.leaving)
    expect(plan.full).toBe(vector.full)
  })
})

describe('splitVault', () => {
  it.each(cases)('$name', (vector) => {
    const vault = build(vector.entries)
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
