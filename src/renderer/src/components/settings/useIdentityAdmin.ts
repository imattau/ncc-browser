import { useCallback, useEffect, useState } from 'react'
import type { IdentityList, IdentityStatus } from '@shared/types'
import { messageOf } from '../../lib/format'

const EMPTY_LIST: IdentityList = { identities: [], activeId: null, defaultId: null }

export interface IdentityAdminApi {
  identityList: IdentityList
  secret: string
  setSecret: (value: string) => void
  identityError: string | null
  setIdentityError: (value: string | null) => void
  identityBusy: boolean
  bunker: string
  setBunker: (value: string) => void
  connectBusy: boolean
  remoteError: string | null
  ephemeralSigner: boolean
  /** Select, remove or import an identity that resolves to a status. */
  runIdentity: (action: () => Promise<IdentityStatus>) => Promise<void>
  /** Actions that return a list (set-default) or a status (select, remove). */
  updateIdentityProfile: (action: () => Promise<IdentityStatus | IdentityList>) => Promise<void>
  connectBunker: () => Promise<void>
  toggleEphemeralSigner: (enabled: boolean) => Promise<void>
}

/**
 * Identity list, local-key import/generate, NIP-46 bunker connection and the
 * throwaway-signer switch. Every mutation funnels through one of the three runners
 * below, which keep the list, the busy flag and the error message in step.
 *
 * Called from `SettingsPage` rather than the section so a pasted nsec or bunker URL
 * survives switching to another section and back.
 */
export function useIdentityAdmin(options: {
  open: boolean
  /** Publish a new active identity to the page (and on to the app shell). */
  onStatus: (status: IdentityStatus) => void
}): IdentityAdminApi {
  const [identityList, setIdentityList] = useState<IdentityList>(EMPTY_LIST)
  const [secret, setSecret] = useState('')
  const [identityError, setIdentityError] = useState<string | null>(null)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [bunker, setBunker] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [ephemeralSigner, setEphemeralSigner] = useState(false)

  const { open, onStatus } = options

  useEffect(() => {
    if (!open) return
    setIdentityError(null)
    setSecret('')
    setBunker('')
    setRemoteError(null)
    setConnectBusy(false)
    void Promise.all([window.ncc.identityList(), window.ncc.getConfig()]).then(([list, config]) => {
      setIdentityList(list)
      setEphemeralSigner(config.ephemeralSigner)
    })
  }, [open])

  const refresh = useCallback(async (): Promise<void> => {
    setIdentityList(await window.ncc.identityList())
  }, [])

  const runIdentity = async (action: () => Promise<IdentityStatus>): Promise<void> => {
    setIdentityBusy(true)
    setIdentityError(null)
    try {
      const status = await action()
      onStatus(status)
      await refresh()
      setSecret('')
    } catch (actionError) {
      setIdentityError(messageOf(actionError))
    } finally {
      setIdentityBusy(false)
    }
  }

  const updateIdentityProfile = async (
    action: () => Promise<IdentityStatus | IdentityList>
  ): Promise<void> => {
    setIdentityBusy(true)
    setIdentityError(null)
    try {
      const result = await action()
      onStatus('mode' in result ? result : await window.ncc.identity())
      await refresh()
    } catch (actionError) {
      setIdentityError(messageOf(actionError))
    } finally {
      setIdentityBusy(false)
    }
  }

  const connectBunker = async (): Promise<void> => {
    setConnectBusy(true)
    setRemoteError(null)
    try {
      const status = await window.ncc.identityConnectBunker(bunker)
      onStatus(status)
      await refresh()
      setBunker('')
    } catch (connectError) {
      setRemoteError(messageOf(connectError))
    } finally {
      setConnectBusy(false)
    }
  }

  const toggleEphemeralSigner = async (enabled: boolean): Promise<void> => {
    setEphemeralSigner(enabled)
    setIdentityError(null)
    const result = await window.ncc.setEphemeralSigner(enabled)
    if (!result.ok) {
      setEphemeralSigner(!enabled)
      setIdentityError(result.error ?? 'Could not save the signer setting')
    }
  }

  return {
    identityList,
    secret,
    setSecret,
    identityError,
    setIdentityError,
    identityBusy,
    bunker,
    setBunker,
    connectBusy,
    remoteError,
    ephemeralSigner,
    runIdentity,
    updateIdentityProfile,
    connectBunker,
    toggleEphemeralSigner
  }
}
