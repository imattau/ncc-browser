import { useEffect, useRef, useState } from 'react'
import { Lock, Star } from 'lucide-react'
import type { SecuritySummary } from '../lib/security'
import type { PopoverAnchor } from './Popover'
import { cn } from '../lib/cn'

interface AddressBarProps {
  value: string
  loading: boolean
  hint: string | null
  bookmarked: boolean
  security: SecuritySummary
  onToggleBookmark: () => void
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
  onToggleBookmark,
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
