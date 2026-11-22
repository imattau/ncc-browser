import { useCallback, useEffect, useState } from 'react'
import type { HostingState } from '@shared/hosting'
import type { NetworkChange, PortStatusEvent } from '@shared/reachability'
import { messageOf } from '../../lib/format'
import type { ExternalChecks, HostingFeedback } from './types'

export interface HostingStateApi extends HostingFeedback {
  state: HostingState | null
  strictAnchors: boolean
  externalChecks: ExternalChecks
  networkChanges: NetworkChange[]
  portAlerts: PortStatusEvent[]
  dismissPortAlert: (localPort: number) => void
  dismissNetworkChange: (change: NetworkChange) => void
  acceptNetworkChange: (change: NetworkChange, publish?: boolean) => Promise<void>
}

/**
 * Hosting data and the feedback shared by every hosting action. The services,
 * network alerts and settings are loaded here; identities and contacts have their
 * own hooks so this one stays a subscription module.
 */
export function useHostingState(): HostingStateApi {
  const [state, setState] = useState<HostingState | null>(null)
  const [busy, setBusy] = useState(false)
  const [strictAnchors, setStrictAnchors] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [externalChecks, setExternalChecks] = useState<ExternalChecks>('ask')
  const [networkChanges, setNetworkChanges] = useState<NetworkChange[]>([])
  const [portAlerts, setPortAlerts] = useState<PortStatusEvent[]>([])

  const apply = useCallback((next: HostingState) => setState(next), [])

  useEffect(() => {
    let alive = true
    void window.ncc.getConfig().then((config) => {
      if (!alive) return
      setStrictAnchors(config.anchorRequired)
      setExternalChecks(config.externalAddressChecks ?? 'ask')
    })
    void window.ncc.hostingState().then((next) => alive && apply(next))
    void window.ncc
      .hostingNetworkChanges()
      .then((changes) => alive && setNetworkChanges(changes))
      .catch(() => undefined)
    const off = window.ncc.onHostingChanged((next) => alive && apply(next))
    const offPortStatus = window.ncc.onPortStatus((event) => {
      if (!alive) return
      setPortAlerts((current) =>
        event.state === 'failing'
          ? [
              ...current.filter(
                (entry) => entry.mapping.localPort !== event.mapping.localPort
              ),
              event
            ]
          : current.filter((entry) => entry.mapping.localPort !== event.mapping.localPort)
      )
    })
    const offNetwork = window.ncc.onNetworkChanged((change) => {
      if (!alive) return
      setNetworkChanges((current) =>
        current.some(
          (entry) =>
            entry.interface === change.interface && entry.from === change.from && entry.to === change.to
        )
          ? current
          : [...current, change].slice(-20)
      )
    })
    return () => {
      alive = false
      off()
      offNetwork()
      offPortStatus()
    }
  }, [apply])

  const copy = async (id: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    } catch {
      setError('Could not copy to the clipboard')
    }
  }

  const acceptNetworkChange = async (
    change: NetworkChange,
    publish = false
  ): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.ncc.hostingReplaceAddress(change.from, change.to, publish)
      apply(result.state)
      setNetworkChanges((current) => current.filter((entry) => entry !== change))
      if (result.updated === 0) {
        setError('No service endpoint used that address.')
      } else if (result.failures.length > 0) {
        setError(
          `Updated ${result.updated} service${result.updated === 1 ? '' : 's'}, but ` +
            `${result.failures.length} publish failed: ${result.failures[0].error}`
        )
      }
    } catch (replaceError) {
      setError(messageOf(replaceError))
    } finally {
      setBusy(false)
    }
  }

  return {
    state,
    apply,
    busy,
    setBusy,
    error,
    setError,
    copied,
    copy,
    strictAnchors,
    externalChecks,
    networkChanges,
    portAlerts,
    dismissPortAlert: (localPort) =>
      setPortAlerts((current) =>
        current.filter((entry) => entry.mapping.localPort !== localPort)
      ),
    dismissNetworkChange: (change) =>
      setNetworkChanges((current) => current.filter((entry) => entry !== change)),
    acceptNetworkChange
  }
}
