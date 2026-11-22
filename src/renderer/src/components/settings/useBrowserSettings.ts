import { useCallback, useEffect, useState } from 'react'
import { formatBytes, type CacheInfo } from '@shared/site-data'
import type { SearchEngineId } from '@shared/search'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_TOR_SOCKS,
  type AppConfig,
  type AppearanceConfig,
  type ExternalAddressCheck,
  type HttpsMode,
  type ProtectionLevel,
  type RelayEntry,
  type TorMode,
  type TorStatus
} from '@shared/types'
import { applyAppearance } from '../../lib/appearance'
import { messageOf } from '../../lib/format'

/** Relay, resolution, Tor and search settings: the General section. */
export interface GeneralSettingsApi {
  relayEntries: RelayEntry[]
  setRelayEntries: (value: RelayEntry[]) => void
  newRelay: string
  setNewRelay: (value: string) => void
  relayBusy: boolean
  gossip: boolean
  setGossip: (value: boolean) => void
  anchorRequired: boolean
  setAnchorRequired: (value: boolean) => void
  externalAddressChecks: ExternalAddressCheck
  setExternalAddressChecks: (value: ExternalAddressCheck) => void
  preferTor: boolean
  setPreferTor: (value: boolean) => void
  torMode: TorMode
  setTorMode: (value: TorMode) => void
  torSocks: string
  setTorSocks: (value: string) => void
  torStatus: TorStatus | null
  torBusy: boolean
  searchEngine: SearchEngineId
  setSearchEngine: (value: SearchEngineId) => void
  searchCustom: string
  setSearchCustom: (value: string) => void
  useOnionSearch: boolean
  setUseOnionSearch: (value: boolean) => void
  nccSearchEnabled: boolean
  setNccSearchEnabled: (value: boolean) => void
  error: string | null
  setError: (value: string | null) => void
  saved: boolean
  setSaved: (value: boolean) => void
  loading: boolean
  addRelay: () => Promise<void>
  removeRelay: (url: string) => void
  save: () => Promise<void>
  testTor: () => Promise<void>
}

/** HTTPS policy, protection level, exceptions, cache and browsing history. */
export interface SecuritySettingsApi {
  httpsMode: HttpsMode
  setHttpsMode: (value: HttpsMode) => void
  warnInsecure: boolean
  setWarnInsecure: (value: boolean) => void
  protectionLevel: ProtectionLevel
  setProtectionLevel: (value: ProtectionLevel) => void
  blockScripts: boolean
  setBlockScripts: (value: boolean) => void
  httpExceptions: string[]
  historyCleared: boolean
  cache: CacheInfo | null
  cacheBusy: boolean
  cacheNotice: string | null
  cacheError: string | null
  error: string | null
  saved: boolean
  setSaved: (value: boolean) => void
  loading: boolean
  saveSecurity: () => Promise<void>
  removeHttpException: (key: string) => Promise<void>
  clearHttpExceptions: () => Promise<void>
  clearBrowsingHistory: () => Promise<void>
  clearCache: () => Promise<void>
}

export interface AppearanceSettingsApi {
  appearance: AppearanceConfig
  error: string | null
  change: (patch: Partial<AppearanceConfig>) => void
  reset: () => void
}

export interface BrowserSettings {
  general: GeneralSettingsApi
  security: SecuritySettingsApi
  appearance: AppearanceSettingsApi
}

/**
 * Configuration state shared by the settings sections that read `AppConfig`.
 *
 * It lives above the section components so switching sections keeps unsaved edits:
 * General and Security are unmounted when another section is shown. The save paths
 * stay separate — Security persists what it owns, and General's save also rewrites
 * the security block, which is what the single-button flow did before the split.
 */
export function useBrowserSettings(options: { open: boolean }): BrowserSettings {
  // General
  const [relayEntries, setRelayEntries] = useState<RelayEntry[]>([])
  const [newRelay, setNewRelay] = useState('')
  const [relayBusy, setRelayBusy] = useState(false)
  const [gossip, setGossip] = useState(true)
  const [anchorRequired, setAnchorRequired] = useState(false)
  const [externalAddressChecks, setExternalAddressChecks] = useState<ExternalAddressCheck>('ask')
  const [preferTor, setPreferTor] = useState(false)
  const [torMode, setTorMode] = useState<TorMode>('auto')
  const [torSocks, setTorSocks] = useState(DEFAULT_TOR_SOCKS)
  const [torStatus, setTorStatus] = useState<TorStatus | null>(null)
  const [torBusy, setTorBusy] = useState(false)
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>('duckduckgo')
  const [searchCustom, setSearchCustom] = useState('')
  const [useOnionSearch, setUseOnionSearch] = useState(true)
  const [nccSearchEnabled, setNccSearchEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(false)

  // Security
  const [httpsMode, setHttpsMode] = useState<HttpsMode>('prefer')
  const [warnInsecure, setWarnInsecure] = useState(false)
  const [protectionLevel, setProtectionLevel] = useState<ProtectionLevel>('standard')
  const [blockScripts, setBlockScripts] = useState(false)
  const [httpExceptions, setHttpExceptions] = useState<string[]>([])
  const [historyCleared, setHistoryCleared] = useState(false)
  const [cache, setCache] = useState<CacheInfo | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  const [cacheNotice, setCacheNotice] = useState<string | null>(null)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const [securityError, setSecurityError] = useState<string | null>(null)
  const [securitySaved, setSecuritySaved] = useState(false)
  const [securityLoading, setSecurityLoading] = useState(false)

  // Appearance
  const [appearance, setAppearance] = useState<AppearanceConfig>(DEFAULT_APPEARANCE)
  const [appearanceError, setAppearanceError] = useState<string | null>(null)

  const applyConfig = useCallback(
    (config: AppConfig) => {
      setRelayEntries(config.relays)
      setGossip(config.gossip)
      setAnchorRequired(config.anchorRequired)
      setExternalAddressChecks(config.externalAddressChecks ?? 'ask')
      setPreferTor(config.preferTor)
      setTorMode(config.torMode)
      setTorSocks(config.torSocks)
      setHttpsMode(config.httpsMode)
      setWarnInsecure(config.warnInsecure)
      setProtectionLevel(config.protection?.level ?? 'standard')
      setBlockScripts(config.protection?.blockScripts ?? false)
      setHttpExceptions(config.httpExceptions ?? [])
      setSearchEngine(config.searchEngine)
      setSearchCustom(config.searchEngineCustom)
      setUseOnionSearch(config.useOnionSearch)
      setNccSearchEnabled(config.nccSearchEnabled === true)
      setAppearance(config.appearance)
      applyAppearance(config.appearance)
    },
    []
  )

  useEffect(() => {
    if (!options.open) return
    setError(null)
    setSaved(false)
    setSecurityError(null)
    setSecuritySaved(false)
    setHistoryCleared(false)
    setAppearanceError(null)
    setCacheNotice(null)
    setCacheError(null)
    void Promise.all([window.ncc.getConfig(), window.ncc.torStatus(), window.ncc.cacheInfo()]).then(
      ([config, tor, cacheInfo]) => {
        applyConfig(config)
        setTorStatus(tor)
        setCache(cacheInfo)
      }
    )
  }, [options.open, applyConfig])

  // A locator-backed relay can rotate while Settings is open. Merge only those
  // entries so unsaved edits to other rows are kept.
  useEffect(() => {
    if (!options.open) return
    return window.ncc.onConfig((config) => {
      setRelayEntries((current) =>
        current.map((entry) => {
          if (!entry.locator) return entry
          const match = config.relays.find(
            (candidate) =>
              candidate.locator?.identity === entry.locator?.identity &&
              candidate.locator?.service === entry.locator?.service
          )
          return match ?? entry
        })
      )
      if (config.appearance) {
        setAppearance(config.appearance)
        applyAppearance(config.appearance)
      }
    })
  }, [options.open])

  useEffect(() => {
    if (!options.open || !torStatus?.starting) return
    const timer = window.setInterval(() => {
      void window.ncc.torStatus().then((status) => {
        setTorStatus(status)
        if (!status.starting) window.clearInterval(timer)
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [options.open, torStatus?.starting])

  const addRelay = async (): Promise<void> => {
    const value = newRelay.trim()
    if (!value) return
    setError(null)
    setRelayBusy(true)
    try {
      let entry: RelayEntry
      if (/^ncc:\/\//i.test(value)) {
        const outcome = await window.ncc.resolveRelayLocator(value)
        if (!outcome.ok) {
          setError(outcome.error)
          return
        }
        entry = outcome.entry
      } else {
        let url: URL
        try {
          url = new URL(value)
        } catch {
          setError(`Not a valid relay URL: ${value}`)
          return
        }
        if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
          setError('Relays must use ws:// or wss://')
          return
        }
        if (url.hash) {
          setError('Relay URLs cannot contain a fragment')
          return
        }
        entry = { url: url.toString().replace(/\/$/, '') }
      }

      if (relayEntries.some((item) => item.url === entry.url)) {
        setError('That relay is already in the list')
        return
      }

      setRelayEntries([...relayEntries, entry])
      setNewRelay('')
      setSaved(false)
    } finally {
      setRelayBusy(false)
    }
  }

  const removeRelay = (url: string): void => {
    setRelayEntries(relayEntries.filter((entry) => entry.url !== url))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    const relayResult = await window.ncc.setRelays(relayEntries)
    if (!relayResult.ok) {
      setLoading(false)
      setError(relayResult.error ?? 'Could not save relays')
      return
    }

    const gossipResult = await window.ncc.setGossip(gossip)
    if (!gossipResult.ok) {
      setLoading(false)
      setError(gossipResult.error ?? 'Could not save gossip setting')
      return
    }

    const anchorResult = await window.ncc.setAnchorRequired(anchorRequired)
    if (!anchorResult.ok) {
      setLoading(false)
      setError(anchorResult.error ?? 'Could not save anchoring setting')
      return
    }

    const externalResult = await window.ncc.setExternalAddressChecks(externalAddressChecks)
    if (!externalResult.ok) {
      setLoading(false)
      setError(externalResult.error ?? 'Could not save public address setting')
      return
    }

    const torResult = await window.ncc.setTorConfig({
      preferTor,
      mode: torMode,
      socks: torSocks
    })
    if (!torResult.ok) {
      setLoading(false)
      setError(torResult.error ?? 'Could not save Tor settings')
      return
    }

    const securityResult = await window.ncc.setSecurityConfig({ httpsMode, warnInsecure, protection: { level: protectionLevel, blockScripts } })
    if (!securityResult.ok) {
      setLoading(false)
      setError(securityResult.error ?? 'Could not save security settings')
      return
    }

    const searchResult = await window.ncc.setSearchConfig({
      engine: searchEngine,
      custom: searchCustom,
      useOnionSearch,
      nccSearchEnabled
    })
    setLoading(false)
    if (!searchResult.ok) {
      setError(searchResult.error ?? 'Could not save search settings')
      return
    }

    const config =
      searchResult.config ??
      securityResult.config ??
      torResult.config ??
      externalResult.config ??
      anchorResult.config ??
      gossipResult.config ??
      relayResult.config
    if (config) {
      setRelayEntries(config.relays)
      setGossip(config.gossip)
      setAnchorRequired(config.anchorRequired)
      setExternalAddressChecks(config.externalAddressChecks ?? 'ask')
      setPreferTor(config.preferTor)
      setTorMode(config.torMode)
      setTorSocks(config.torSocks)
      setHttpsMode(config.httpsMode)
      setWarnInsecure(config.warnInsecure)
      setProtectionLevel(config.protection?.level ?? 'standard')
      setBlockScripts(config.protection?.blockScripts ?? false)
      setHttpExceptions(config.httpExceptions ?? [])
      setSearchEngine(config.searchEngine)
      setSearchCustom(config.searchEngineCustom)
      setUseOnionSearch(config.useOnionSearch)
      setNccSearchEnabled(config.nccSearchEnabled === true)
    }
    setTorStatus(await window.ncc.torStatus())
    setSaved(true)
  }

  const saveSecurity = async (): Promise<void> => {
    setSecurityLoading(true)
    setSecurityError(null)
    const result = await window.ncc.setSecurityConfig({ httpsMode, warnInsecure, protection: { level: protectionLevel, blockScripts } })
    setSecurityLoading(false)
    if (!result.ok) {
      setSecurityError(result.error ?? 'Could not save security settings')
      return
    }
    if (result.config) {
      setHttpsMode(result.config.httpsMode)
      setWarnInsecure(result.config.warnInsecure)
      setProtectionLevel(result.config.protection?.level ?? 'standard')
      setBlockScripts(result.config.protection?.blockScripts ?? false)
      setHttpExceptions(result.config.httpExceptions ?? [])
    }
    setSecuritySaved(true)
  }

  const removeHttpException = async (key: string): Promise<void> => {
    const config = await window.ncc.removeHttpException(key)
    setHttpExceptions(config.httpExceptions ?? [])
  }

  const clearHttpExceptions = async (): Promise<void> => {
    const config = await window.ncc.clearHttpExceptions()
    setHttpExceptions(config.httpExceptions ?? [])
  }

  const clearBrowsingHistory = async (): Promise<void> => {
    await window.ncc.clearBrowsingHistory()
    setHistoryCleared(true)
  }

  const clearCache = async (): Promise<void> => {
    setCacheBusy(true)
    setCacheNotice(null)
    setCacheError(null)
    try {
      const before = cache
      const next = await window.ncc.clearCache()
      setCache(next)
      const freed = before ? Math.max(0, before.total - next.total) : 0
      const locators = before?.locators ?? 0
      const suffix = locators > 0 ? ` and ${locators} locator${locators === 1 ? '' : 's'}` : ''
      setCacheNotice(freed > 0 ? `Cleared ${formatBytes(freed)}${suffix}.` : `Cache cleared${suffix}.`)
    } catch (caught) {
      setCacheError(messageOf(caught))
    } finally {
      setCacheBusy(false)
    }
  }

  const testTor = async (): Promise<void> => {
    setTorBusy(true)
    setError(null)
    try {
      setTorStatus(await window.ncc.torTest())
    } finally {
      setTorBusy(false)
    }
  }

  const changeAppearance = (patch: Partial<AppearanceConfig>): void => {
    // Apply optimistically so theme, size and density change in this frame.
    const next = { ...appearance, ...patch }
    setAppearance(next)
    applyAppearance(next)
    setAppearanceError(null)
    void window.ncc.setAppearance(patch).then((result) => {
      if (!result.ok) {
        setAppearanceError(result.error ?? 'Could not save appearance settings')
        return
      }
      if (result.config?.appearance) {
        setAppearance(result.config.appearance)
        applyAppearance(result.config.appearance)
      }
    })
  }

  const resetAppearance = (): void => {
    changeAppearance(DEFAULT_APPEARANCE)
  }

  const general: GeneralSettingsApi = {
    relayEntries,
    setRelayEntries,
    newRelay,
    setNewRelay,
    relayBusy,
    gossip,
    setGossip,
    anchorRequired,
    setAnchorRequired,
    externalAddressChecks,
    setExternalAddressChecks,
    preferTor,
    setPreferTor,
    torMode,
    setTorMode,
    torSocks,
    setTorSocks,
    torStatus,
    torBusy,
    searchEngine,
    setSearchEngine,
    searchCustom,
    setSearchCustom,
    useOnionSearch,
    setUseOnionSearch,
    nccSearchEnabled,
    setNccSearchEnabled,
    error,
    setError,
    saved,
    setSaved,
    loading,
    addRelay,
    removeRelay,
    save,
    testTor
  }

  const security: SecuritySettingsApi = {
    httpsMode,
    setHttpsMode,
    warnInsecure,
    setWarnInsecure,
    protectionLevel,
    setProtectionLevel,
    blockScripts,
    setBlockScripts,
    httpExceptions,
    historyCleared,
    cache,
    cacheBusy,
    cacheNotice,
    cacheError,
    error: securityError,
    saved: securitySaved,
    setSaved: setSecuritySaved,
    loading: securityLoading,
    saveSecurity,
    removeHttpException,
    clearHttpExceptions,
    clearBrowsingHistory,
    clearCache
  }

  const appearanceApi: AppearanceSettingsApi = {
    appearance,
    error: appearanceError,
    change: changeAppearance,
    reset: resetAppearance
  }

  return { general, security, appearance: appearanceApi }
}
