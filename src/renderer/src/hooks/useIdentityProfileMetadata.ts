import { useEffect, useMemo, useState } from 'react'
import type { IdentityProfile, IdentityProfileMetadata } from '@shared/types'

export function useIdentityProfileMetadata(identities: IdentityProfile[]) {
  const pubkeys = useMemo(() => [...new Set(identities.map((item) => item.hexPubkey).filter(Boolean))] as string[], [identities.map((item) => item.hexPubkey).join(',')])
  const key = pubkeys.join(',')
  const [profiles, setProfiles] = useState<Record<string, IdentityProfileMetadata>>({})
  useEffect(() => {
    let live = true
    const accept = (items: IdentityProfileMetadata[]) => {
      if (!live) return
      setProfiles((old) => ({ ...old, ...Object.fromEntries(items.map((item) => [item.pubkey, item])) }))
    }
    const unsubscribe = window.ncc.onIdentityProfileMetadata(accept)
    if (pubkeys.length) void window.ncc.identityProfileMetadata(pubkeys).then(accept).catch(() => undefined)
    return () => { live = false; unsubscribe() }
  }, [key])
  return profiles
}
