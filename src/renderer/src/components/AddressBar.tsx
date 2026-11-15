import { useEffect, useRef, useState } from 'react'
import { Lock, Star } from 'lucide-react'
import type { TorState } from '@shared/types'
import type { SecuritySummary } from '../lib/security'
import type { PopoverAnchor } from './Popover'
import { cn } from '../lib/cn'

interface AddressBarProps {
  value: string
  loading: boolean
  hint: string | null
  bookmarked: boolean
  security: SecuritySummary
  tor: TorState
  onToggleBookmark: () => void
  onToggleTor: () => void
  onOpenSiteInfo: (anchor: PopoverAnchor) => void
  onNavigate: (input: string) => void
  onFocusChange?: (focused: boolean) => void
}

export function AddressBar({
  value,
  loading,
  hint,
  bookmarked,
  security,
  tor,
  onToggleBookmark,
  onToggleTor,
  onOpenSiteInfo,
  onNavigate,
  onFocusChange
}: AddressBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setDraft(value)
  }, [value, focused])

  useEffect(() => {
    const focusAddress = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('ncc:focus-address', focusAddress)
    const unsubscribe = window.ncc.onFocusAddress(focusAddress)
    return () => {
      window.removeEventListener('ncc:focus-address', focusAddress)
      unsubscribe()
    }
  }, [])

  return (
    <div className="relative flex-1">
      <div
        className={cn(
          'flex h-9 items-center gap-2 rounded-xl border bg-[#0e1016] px-3 transition-colors',
          hint
            ? 'border-[color:var(--color-danger)]/60'
            : 'border-[color:var(--color-line)] focus-within:border-[color:var(--color-accent)]/60',
          focused && 'shadow-[0_0_0_3px_rgba(138,180,255,0.10)]'
        )}
      >
        <button
          type="button"
          data-security-button
          data-security-tone={security.tone}
          data-security-label={security.label}
          data-anchor-state={security.anchorState}
          aria-label={`Site security (${security.label})`}
          title={security.tooltip}
          disabled={!security.clickable}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            onOpenSiteInfo({ top: rect.bottom, left: rect.left })
          }}
          className={cn(
            'relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent',
            lockTone(security.tone)
          )}
        >
          <Lock className="h-3.5 w-3.5" />
          {security.anchorState !== 'none' ? (
            <span
              aria-hidden
              className={cn(
                'absolute right-0.5 top-0.5 h-1 w-1 rounded-full',
                anchorDot(security.anchorState)
              )}
            />
          ) : null}
        </button>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            setFocused(true)
            onFocusChange?.(true)
            event.currentTarget.select()
          }}
          onBlur={() => {
            setFocused(false)
            onFocusChange?.(false)
            setDraft(value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              const next = draft.trim()
              if (!next) return
              onNavigate(next)
              inputRef.current?.blur()
            }
            if (event.key === 'Escape') {
              setDraft(value)
              inputRef.current?.blur()
            }
          }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="ncc://npub1…/service"
          aria-label="Address"
          className="h-full flex-1 bg-transparent font-mono text-[13px] text-[#e7e9ef] placeholder:text-[#5d6575] focus:outline-none"
        />
        {tor.onionAvailable && !tor.preferTor ? (
          <button
            type="button"
            data-tor-button
            data-tor-active={tor.active}
            aria-pressed={tor.active}
            aria-label={
              tor.active
                ? 'Using Tor — reload the direct endpoint'
                : 'Onion endpoint available — load over Tor'
            }
            title={
              tor.active
                ? 'Using Tor for this service — click to load the direct endpoint'
                : 'Onion endpoint available — click to load over Tor'
            }
            onClick={onToggleTor}
            className={cn(
              'shrink-0 rounded p-0.5 transition-colors hover:bg-white/5',
              tor.active
                ? 'text-[#c4b5fd]'
                : 'text-[#7c6ad6]/70 hover:text-[#a78bfa]'
            )}
          >
            <OnionMark className="h-3.5 w-3.5" />
          </button>
        ) : null}

        {loading ? (
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[color:var(--color-accent)]/30 border-t-[color:var(--color-accent)]" />
        ) : (
          <button
            type="button"
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
            title={bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)'}
            disabled={value.trim().length === 0}
            onClick={onToggleBookmark}
            className={cn(
              'shrink-0 rounded p-0.5 transition-colors hover:bg-white/5 disabled:cursor-default disabled:opacity-30',
              bookmarked ? 'text-[color:var(--color-warn)]' : 'text-[#3f4553] hover:text-[#c9d1e0]'
            )}
          >
            <Star className="h-3.5 w-3.5" fill={bookmarked ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
      {hint ? (
        <p className="absolute left-3 top-full mt-1.5 text-[11.5px] text-[color:var(--color-danger)]">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function lockTone(tone: SecuritySummary['tone']): string {
  switch (tone) {
    case 'ok':
      return 'text-[color:var(--color-ok)]'
    case 'warn':
      return 'text-[color:var(--color-warn)]'
    case 'danger':
      return 'text-[color:var(--color-danger)]'
    default:
      return 'text-[color:var(--color-muted)]'
  }
}

function anchorDot(state: string): string {
  if (state === 'anchored') return 'bg-[color:var(--color-ok)]'
  if (state === 'expired' || state === 'invalid' || state === 'required-missing') {
    return 'bg-[color:var(--color-warn)]'
  }
  return 'bg-[#5d6575]'
}

/** A layered onion mark for the Tor transport toggle. */
function OnionMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 21c4.7 0 8.2-3.7 8.2-8.2C20.2 7.4 16.5 3 12 3S3.8 7.4 3.8 12.8C3.8 17.3 7.3 21 12 21Z" />
      <path d="M12 18.2c2.9 0 5.1-2.4 5.1-5.5 0-3.2-1.9-5.7-5.1-5.7s-5.1 2.5-5.1 5.7c0 3.1 2.2 5.5 5.1 5.5Z" />
      <path d="M12 15.3c1.3 0 2.2-1.1 2.2-2.7 0-1.6-.9-2.7-2.2-2.7s-2.2 1.1-2.2 2.7c0 1.6.9 2.7 2.2 2.7Z" />
      <path d="M12 3c0-1 .6-1.7 1.6-2" />
    </svg>
  )
}
