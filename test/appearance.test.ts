import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPEARANCE,
  TEXT_SIZE_SCALES,
  normalizeAppearance,
  type AppearanceConfig
} from '../src/shared/types'
import { appearanceBootArgument, readAppearanceBootArgument } from '../src/shared/appearance'

describe('normalizeAppearance', () => {
  it('falls back to the dark default for missing input', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE)
    expect(normalizeAppearance('dark')).toEqual(DEFAULT_APPEARANCE)
  })

  it('keeps valid values', () => {
    const input: AppearanceConfig = {
      ...DEFAULT_APPEARANCE,
      theme: 'light',
      textSize: 'xlarge',
      accent: 'green',
      density: 'compact',
      reduceMotion: true
    }
    expect(normalizeAppearance(input)).toEqual(input)
  })

  it('rejects unknown values field by field', () => {
    const normalized = normalizeAppearance({
      theme: 'sepia',
      textSize: 'enormous',
      accent: 'pink',
      density: 'airy',
      reduceMotion: 'yes'
    })
    expect(normalized).toEqual(DEFAULT_APPEARANCE)
  })

  it('keeps a partial config’s valid fields', () => {
    expect(normalizeAppearance({ theme: 'system', accent: 'amber' })).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: 'system',
      accent: 'amber'
    })
  })
})

describe('text size presets', () => {
  it('maps every preset to a positive scale', () => {
    for (const scale of Object.values(TEXT_SIZE_SCALES)) {
      expect(scale).toBeGreaterThan(0)
    }
    expect(TEXT_SIZE_SCALES.default).toBe(1)
    expect(TEXT_SIZE_SCALES.small).toBeLessThan(1)
    expect(TEXT_SIZE_SCALES.xlarge).toBeGreaterThan(TEXT_SIZE_SCALES.large)
  })
})

describe('appearance boot argument', () => {
  it('round-trips through the preload argument list', () => {
    const appearance: AppearanceConfig = {
      ...DEFAULT_APPEARANCE,
      theme: 'system',
      textSize: 'large',
      accent: 'violet',
      density: 'compact',
      reduceMotion: true
    }
    const argv = ['electron', appearanceBootArgument(appearance)]
    expect(readAppearanceBootArgument(argv)).toEqual(appearance)
  })

  it('returns null for a missing or malformed argument', () => {
    expect(readAppearanceBootArgument(['electron'])).toBeNull()
    expect(readAppearanceBootArgument(['electron', '--ncc-appearance=%7B'])).toBeNull()
  })
})
