import type {
  InsecurePrompt,
  NavState,
  PageMode,
  SecurityBanner,
  SecurityInfo,
  TabKind,
  TabSummary
} from '@shared/types'
import { tabTitle } from './format'
import type { Tab } from './types'

export function tabSummaries(tabs: Tab[]): TabSummary[] {
  return tabs.map((tab) => ({
    id: tab.id,
    kind: tab.kind,
    title: tabTitle(tab),
    url: tab.displayUrl,
    loading: tab.loading,
    favicon: tab.favicon,
    audible: tab.audible,
    muted: tab.muted
  }))
}

export interface ActiveTabNav {
  mode: PageMode
  displayUrl: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  security: SecurityInfo | null
  failure: { code: string; message: string } | null
  tor: { onionAvailable: boolean; active: boolean }
  kind: TabKind
  title: string
}

interface NavStateInput {
  active: ActiveTabNav | null
  tabs: TabSummary[]
  activeTabId: string | null
  preferTor: boolean
  windowMaximized: boolean
  banner: SecurityBanner | null
  insecurePrompt: InsecurePrompt | null
}

export function buildNavState(input: NavStateInput): NavState {
  const { active } = input
  return {
    mode: active?.mode ?? 'blank',
    displayUrl: active?.displayUrl ?? '',
    url: active?.url ?? '',
    title: active?.title ?? '',
    loading: active?.loading ?? false,
    canGoBack: active?.canGoBack ?? false,
    canGoForward: active?.canGoForward ?? false,
    security: active?.security ?? null,
    failure: active?.failure ?? null,
    tor: {
      preferTor: input.preferTor,
      onionAvailable: active?.tor.onionAvailable ?? false,
      active: active?.tor.active ?? false,
      tabTor: active?.kind === 'tor'
    },
    tabKind: active?.kind ?? 'normal',
    banner: input.banner,
    insecurePrompt: input.insecurePrompt,
    tabs: input.tabs,
    activeTabId: input.activeTabId,
    windowMaximized: input.windowMaximized
  }
}
