import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the light palette as well as the dark one. Every pair below is text drawn
 * on the surface named after it, so WCAG AA (4.5:1) is the floor.
 */
const css = readFileSync(join(__dirname, '../src/renderer/src/index.css'), 'utf8')

type Palette = Record<string, [light: string, dark: string]>

function tokenBlock(source: string): Palette {
  const palette: Palette = {}
  const pattern = /--color-([a-z-]+):\s*light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/g
  for (const match of source.matchAll(pattern)) {
    palette[match[1]] = [match[2], match[3]]
  }
  return palette
}

function accentPreset(name: string): [light: string, dark: string] {
  const start = css.indexOf(`:root[data-accent='${name}']`)
  expect(start, `missing ${name} accent preset`).toBeGreaterThan(-1)
  const block = css.slice(start, css.indexOf('}', start))
  const match = block.match(/--color-accent:\s*light-dark\(\s*(#[0-9a-fA-F]{6})\s*,\s*(#[0-9a-fA-F]{6})\s*\)/)
  expect(match, `missing accent value for ${name}`).not.toBeNull()
  return [match![1], match![2]]
}

function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

const themeStart = css.indexOf('@theme {')
const themeEnd = css.indexOf('}', themeStart)
const palette = tokenBlock(css.slice(themeStart, themeEnd))

const TEXT_PAIRS: Array<[foreground: string, background: string]> = [
  ['text-strong', 'panel'],
  ['text', 'field'],
  ['text-soft', 'panel'],
  ['muted', 'panel'],
  ['faint', 'panel'],
  ['accent', 'panel'],
  ['danger', 'panel'],
  ['warn', 'panel'],
  ['ok', 'ink'],
  ['on-accent', 'accent'],
  ['on-warn', 'warn']
]

describe('appearance palette', () => {
  it('defines a light and a dark value for every tested token', () => {
    for (const [foreground, background] of TEXT_PAIRS) {
      expect(palette[foreground], foreground).toBeDefined()
      expect(palette[background], background).toBeDefined()
    }
  })

  it.each(TEXT_PAIRS)('keeps %s on %s readable in both themes', (foreground, background) => {
    const [lightForeground, darkForeground] = palette[foreground]
    const [lightBackground, darkBackground] = palette[background]
    expect(contrast(lightForeground, lightBackground)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(darkForeground, darkBackground)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['blue', 'violet', 'green', 'amber'] as const)(
    'keeps the %s accent readable in both themes',
    (name) => {
      const [light, dark] = name === 'blue' ? palette.accent : accentPreset(name)
      const [lightOn] = palette['on-accent']
      const [, darkOn] = palette['on-accent']
      expect(contrast(lightOn, light)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(darkOn, dark)).toBeGreaterThanOrEqual(4.5)
    }
  )
})
