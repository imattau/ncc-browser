import { useEffect, useMemo, useState } from 'react'
import { nip19 } from 'nostr-tools'
import type { IdentityList, IdentityStatus } from '@shared/types'
import { messageOf } from '../../lib/format'

export interface HostingIdentityApi {
  identityList: IdentityList | null
  identityBusy: boolean
  ephemeralNsec: string | null
  addIdentityToList: boolean
  setAddIdentityToList: (value: boolean) => void
  /** The active identity as an npub, or an empty string. */
  npub: string
  selectIdentity: (id: string) => Promise<void>
  createIdentity: () => Promise<void>
  saveEphemeral: () => Promise<void>
  revealEphemeral: () => Promise<void>
  discardEphemeral: () => Promise<void>
}

interface Options {
  identity: IdentityStatus | null
  onIdentityChange?: (status: IdentityStatus) => void
  setError: (value: string | null) => void
}

/** Identity switching inside the hosting flow, plus its identity list. */
export function useHostingIdentity({
  identity,
  onIdentityChange,
  setError
}: Options): HostingIdentityApi {
  const [identityBusy, setIdentityBusy] = useState(false)
  const [ephemeralNsec, setEphemeralNsec] = useState<string | null>(null)
  const [identityList, setIdentityList] = useState<IdentityList | null>(null)
  const [addIdentityToList, setAddIdentityToList] = useState(true)

  useEffect(() => {
    let alive = true
    void window.ncc
      .identityList()
      .then((list) => alive && setIdentityList(list))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const refreshIdentities = async (): Promise<void> => {
    try {
      setIdentityList(await window.ncc.identityList())
    } catch {
      // keep the last known list
    }
  }

  const selectIdentity = async (id: string): Promise<void> => {
    if (!id || id === identity?.hexPubkey) return
    if (
      identity?.source === 'session' &&
      !window.confirm('Switch identities and discard this one-off key? Copy its nsec first if you need it.')
    ) {
      return
    }
    setIdentityBusy(true)
    setError(null)
    try {
      const status = await window.ncc.identitySelect(id)
      setEphemeralNsec(null)
      onIdentityChange?.(status)
      await refreshIdentities()
    } catch (identityError) {
      setError(messageOf(identityError))
    } finally {
      setIdentityBusy(false)
    }
  }

  const createIdentity = async (): Promise<void> => {
    if (
      identity?.source === 'session' &&
      !window.confirm('Replace this one-off identity? Copy its nsec first if you need it.')
    ) {
      return
    }
    setIdentityBusy(true)
    setError(null)
    try {
      if (!addIdentityToList) {
        const result = await window.ncc.generateEphemeralIdentity()
        setEphemeralNsec(result.nsec)
        onIdentityChange?.(result.status)
      } else {
        const status = await window.ncc.generateIdentity()
        setEphemeralNsec(null)
        onIdentityChange?.(status)
      }
      await refreshIdentities()
    } catch (identityError) {
      setError(messageOf(identityError))
    } finally {
      setIdentityBusy(false)
    }
  }

  const saveEphemeral = async (): Promise<void> => {
    setIdentityBusy(true)
    setError(null)
    try {
      const status = await window.ncc.saveEphemeralIdentity()
      setEphemeralNsec(null)
      onIdentityChange?.(status)
      await refreshIdentities()
    } catch (identityError) {
      setError(messageOf(identityError))
    } finally {
      setIdentityBusy(false)
    }
  }

  const revealEphemeral = async (): Promise<void> => {
    try {
      const nsec = await window.ncc.ephemeralIdentitySecret()
      if (nsec) setEphemeralNsec(nsec)
    } catch (identityError) {
      setError(messageOf(identityError))
    }
  }

  const discardEphemeral = async (): Promise<void> => {
    setIdentityBusy(true)
    try {
      const status = await window.ncc.clearEphemeralIdentity()
      setEphemeralNsec(null)
      onIdentityChange?.(status)
      await refreshIdentities()
    } catch (identityError) {
      setError(messageOf(identityError))
    } finally {
      setIdentityBusy(false)
    }
  }

  const npub = useMemo(() => {
    if (identity?.npub) return identity.npub
    if (identity?.hexPubkey) {
      try {
        return nip19.npubEncode(identity.hexPubkey)
      } catch {
        return ''
      }
    }
    return ''
  }, [identity])

  return {
    identityList,
    identityBusy,
    ephemeralNsec,
    addIdentityToList,
    setAddIdentityToList,
    npub,
    selectIdentity,
    createIdentity,
    saveEphemeral,
    revealEphemeral,
    discardEphemeral
  }
}
