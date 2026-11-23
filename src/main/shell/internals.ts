import type { Input } from 'electron'
import type { TabKind } from '@shared/types'
import type { ShellDeps } from '../shell'
import type { Tab } from './types'

/**
 * The small piece of `BrowserShell` that navigation and tab wiring need. The shell
 * builds this once with closures, so the modules can drive private state without the
 * class exposing its tab list or deps publicly.
 */
export interface ShellInternals {
  deps: ShellDeps
  syncState: () => void
  scheduleSessionSave: () => void
  activateTab: (id: string) => void
  showOnly: (id: string) => void
  applyUrlToTab: (tab: Tab, url: string) => void
  openInNewTab: (url: string, kind?: TabKind) => Promise<void>
  handleInput: (event: { preventDefault(): void }, input: Input) => void
  hasTab: (tab: Tab) => boolean
  showInsecurePrompt: (tab: Tab, url: string, key: string) => void
  closeTab: (id: string) => void
}
