import {
  DEFAULT_APPEARANCE,
  TEXT_SIZE_SCALES,
  normalizeAppearance,
  type AppearanceConfig
} from '@shared/types'

/**
 * Appearance is carried by data attributes on `<html>`: the stylesheet turns them
 * into the font scale, density spacing, accent tokens and motion policy. Theme is
 * not set here; Electron's `nativeTheme` drives `prefers-color-scheme`.
 */
export function applyAppearance(input: unknown): AppearanceConfig {
  const appearance = normalizeAppearance(input ?? DEFAULT_APPEARANCE)
  const root = document.documentElement
  root.dataset.theme = appearance.theme
  root.dataset.textSize = appearance.textSize
  root.dataset.accent = appearance.accent
  root.dataset.density = appearance.density
  root.dataset.reduceMotion = appearance.reduceMotion ? 'true' : 'false'
  root.style.setProperty('--ui-font-scale', String(TEXT_SIZE_SCALES[appearance.textSize]))
  return appearance
}
