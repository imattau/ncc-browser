import { nativeTheme } from 'electron'
import type { ThemePreference } from '@shared/types'

/**
 * Electron's native theme is the single source of truth for the chrome: setting
 * `themeSource` updates `prefers-color-scheme`, which both our CSS tokens and any
 * page that supports dark mode follow.
 */
export function applyThemeSource(theme: ThemePreference): void {
  nativeTheme.themeSource = theme
}

/** Keep the window's own background in step so a resize never flashes the old theme. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0b0c10' : '#f2f4f8'
}
