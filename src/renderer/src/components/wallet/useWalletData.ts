import { useEffect, useState } from 'react'
import type { NwcSnapshot, WalletSnapshot } from '@shared/wallet'
import { messageOf } from '../../lib/format'
import type { WalletContext, WalletSettings } from './types'

export type WalletData = Omit<WalletContext, 'onOpenIdentitySettings'>

/** Snapshot, settings, NWC status and the shared status line. */
export function useWalletData(): WalletData {
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null)
  const [settings, setSettings] = useState<WalletSettings | null>(null)
  const [nwc, setNwc] = useState<NwcSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function refresh() {
    setBusy(true)
    setMessage('')
    try {
      const [next, prefs] = await Promise.all([
        window.ncc.walletSnapshot(),
        window.ncc.walletSettings()
      ])
      setSnapshot(next)
      setSettings(prefs)
      const nwcStatus = await window.ncc.nwcStatus()
      setNwc(nwcStatus.connected ? await window.ncc.nwcRefresh() : nwcStatus)
    } catch (error) {
      setMessage(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setMessage('Copied to clipboard.')
    } catch {
      setMessage('Could not copy to clipboard.')
    }
  }

  async function saveSettings(esploraUrl: string): Promise<boolean> {
    setBusy(true)
    try {
      setSettings(await window.ncc.walletSetSettings({ esploraUrl }))
      await refresh()
      return true
    } catch (error) {
      setMessage(messageOf(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  return {
    snapshot,
    settings,
    nwc,
    setNwc,
    busy,
    setBusy,
    message,
    setMessage,
    refresh,
    copy,
    saveSettings
  }
}
