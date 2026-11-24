import type { IdentityProfileMetadata } from '@shared/types'
import type { ReactNode } from 'react'
import { shortIdentity } from '../lib/format'

export function IdentityAvatar({ profile, fallback, size = 'h-9 w-9' }: {
  profile?: IdentityProfileMetadata
  fallback: string
  size?: string
}) {
  return <span className="relative inline-flex shrink-0">
    <span aria-hidden="true" className={`${size} flex shrink-0 items-center justify-center rounded-full bg-[color:var(--color-accent)]/15 text-ui-10 font-semibold text-[color:var(--color-accent)]`}>{(profile?.name ?? fallback).trim().slice(0, 1).toUpperCase() || '?'}</span>
    {profile?.pictureDataUrl ? <img src={profile.pictureDataUrl} alt="" onError={(event) => { event.currentTarget.hidden = true }} className={`absolute inset-0 ${size} shrink-0 rounded-full object-cover`} /> : null}
  </span>
}

export function IdentityLabels({ profile, npub, fallback, detail }: {
  profile?: IdentityProfileMetadata
  npub?: string | null
  fallback: string
  detail?: ReactNode
}) {
  const label = profile?.name?.trim() || npub || fallback
  return <span className="min-w-0 flex-1">
    <span className="block truncate text-ui-11 text-[color:var(--color-text-strong)]">{label}</span>
    {profile?.name && npub ? <span className="block truncate font-mono text-ui-95 text-[color:var(--color-muted)]">{shortIdentity(npub)}</span> : null}
    {detail ? <span className="mt-0.5 block text-ui-10 text-[color:var(--color-muted)]">{detail}</span> : null}
  </span>
}
