import { useEffect, useRef, useState } from 'react'
import { EyeOff, Lock, Star } from 'lucide-react'
import type { OmniboxSuggestion, TabKind, TorState } from '@shared/types'
import { TAB_KIND_SUMMARY } from '../lib/tab-kind'
import type { SecuritySummary } from '../lib/security'
import type { PopoverAnchor } from './Popover'
import { Omnibox } from './Omnibox'
import { OnionIcon } from './TransportIcons'
import { cn } from '../lib/cn'

const SUGGEST_DEBOUNCE_MS = 70
const OMNI_ID = 'ncc-omnibox'

interface AddressBarProps {
  value: string
  loading: boolean
  hint: string | null
  bookmarked: boolean
  security: SecuritySummary
  tor: TorState
  tabKind: TabKind
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
  tabKind,
  onToggleBookmark,
  onToggleTor,
  onOpenSiteInfo,
  onNavigate,
  onFocusChange
}: AddressBarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<OmniboxSuggestion[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const seqRef = useRef(0)
  const committedRef = useRef(false)
  const suppressRef = useRef(false)

  // Keep the draft in sync with navigation. `focused` alone is not enough: an
  // overlay (site info, settings) can move focus without React seeing a blur, which
  // would otherwise leave a stale address on screen.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(value)
  }, [value])

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

  // Local suggestions only; a stale response is dropped through the sequence guard.
  useEffect(() => {
    const seq = (seqRef.current += 1)
    if (!focused) {
      setSuggestions([])
      setActiveIndex(-1)
      return
    }
    if (suppressRef.current) {
      // Tab completion updates the draft; keep the dropdown closed until the next edit.
      suppressRef.current = false
      setSuggestions([])
      setActiveIndex(-1)
      return
    }

    const timer = window.setTimeout(() => {
      void window.ncc
        .omniboxSuggest(draft)
        .then((next) => {
          if (seqRef.current !== seq) return
          setSuggestions(next)
          setActiveIndex(-1)
        })
        .catch(() => {
          if (seqRef.current === seq) setSuggestions([])
        })
    }, SUGGEST_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [draft, focused, tabKind])

  const clearSuggestions = (): void => {
    setSuggestions([])
    setActiveIndex(-1)
  }

  const openSuggestion = (suggestion: OmniboxSuggestion, newTab = false): void => {
    clearSuggestions()
    if (!suggestion.url) return

    committedRef.current = true
    setDraft(suggestion.url)
    inputRef.current?.blur()

    if (newTab) {
      if (tabKind === 'private') void window.ncc.newPrivateTab(suggestion.url)
      else if (tabKind === 'tor') void window.ncc.newTorTab(suggestion.url)
      else void window.ncc.newTab(suggestion.url)
      return
    }

    if (suggestion.tabId) {
      void window.ncc.selectTab(suggestion.tabId)
      return
    }

    onNavigate(suggestion.url)
  }

  const moveSelection = (direction: 1 | -1): void => {
    if (suggestions.length === 0) return
    setActiveIndex((current) => {
      if (direction === 1) return current >= suggestions.length - 1 ? 0 : current + 1
      return current <= 0 ? suggestions.length - 1 : current - 1
    })
  }

  const completeInline = (): void => {
    if (suggestions.length === 0) return
    const suggestion = suggestions[activeIndex] ?? suggestions[0]
    if (!suggestion?.url) return
    suppressRef.current = true
    setDraft(suggestion.url)
    clearSuggestions()
  }

  return (
    <div className="relative flex-1">
      <div
        className={cn(
          'flex h-9 items-center gap-2 rounded-xl border bg-[color:var(--color-field)] px-3 transition-colors',
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
            'relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[color:var(--color-hover-strong)] disabled:cursor-default disabled:hover:bg-transparent',
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
        {tabKind === 'tor' ? (
          <span
            data-tab-kind-badge="tor"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[color:var(--color-tor)]/45 bg-[color:var(--color-tor)]/12 px-1.5 py-0.5 text-ui-95 font-semibold text-[color:var(--color-tor-text)]"
            title={TAB_KIND_SUMMARY.tor}
          >
            <OnionIcon className="h-3 w-3" />
            Tor
          </span>
        ) : tabKind === 'private' ? (
          <span
            data-tab-kind-badge="private"
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[color:var(--color-private)]/45 bg-[color:var(--color-private)]/12 px-1.5 py-0.5 text-ui-95 font-semibold text-[color:var(--color-private-text)]"
            title={TAB_KIND_SUMMARY.private}
          >
            <EyeOff className="h-3 w-3" />
            Private
          </span>
        ) : null}
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
            clearSuggestions()
            if (committedRef.current) committedRef.current = false
            else setDraft(value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (suggestions.length === 0) return
              event.preventDefault()
              moveSelection(event.key === 'ArrowDown' ? 1 : -1)
              return
            }
            if (event.key === 'Tab' && suggestions.length > 0) {
              event.preventDefault()
              completeInline()
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              const suggestion = activeIndex >= 0 ? suggestions[activeIndex] : undefined
              if (suggestion) {
                openSuggestion(suggestion, event.altKey)
                return
              }
              const next = draft.trim()
              if (!next) return
              committedRef.current = true
              clearSuggestions()
              onNavigate(next)
              inputRef.current?.blur()
              return
            }
            if (event.key === 'Escape') {
              if (suggestions.length > 0) {
                event.preventDefault()
                clearSuggestions()
                return
              }
              setDraft(value)
              inputRef.current?.blur()
            }
          }}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={OMNI_ID}
          aria-autocomplete="list"
          aria-activedescendant={
            activeIndex >= 0 ? `${OMNI_ID}-option-${activeIndex}` : undefined
          }
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Search or enter an address"
          aria-label="Address"
          className="h-full flex-1 bg-transparent font-mono text-ui-13 text-[color:var(--color-text-strong)] placeholder:text-[color:var(--color-faint)] focus:outline-none"
        />
        {!tor.tabTor && tor.onionAvailable && !tor.preferTor ? (
          <button
            type="button"
            data-tor-button
            aria-label="Onion endpoint available — open this page in a Tor tab"
            title="Onion endpoint available — open in a Tor tab"
            onClick={onToggleTor}
            className={cn(
              'shrink-0 rounded p-0.5 transition-colors hover:bg-[color:var(--color-hover)]',
              'text-[color:var(--color-tor)]/70 hover:text-[color:var(--color-tor-text)]'
            )}
          >
            <OnionIcon className="h-3.5 w-3.5" />
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
              'shrink-0 rounded p-0.5 transition-colors hover:bg-[color:var(--color-hover)] disabled:cursor-default disabled:opacity-30',
              bookmarked ? 'text-[color:var(--color-warn)]' : 'text-[color:var(--color-line-strong)] hover:text-[color:var(--color-text-soft)]'
            )}
          >
            <Star className="h-3.5 w-3.5" fill={bookmarked ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>

      <Omnibox
        id={OMNI_ID}
        suggestions={suggestions}
        activeIndex={activeIndex}
        query={draft}
        hint={suggestions.length > 0 ? hint : null}
        onHover={setActiveIndex}
        onPick={(suggestion) => openSuggestion(suggestion)}
      />

      {hint && suggestions.length === 0 ? (
        <p className="absolute left-3 top-full mt-1.5 text-ui-115 text-[color:var(--color-danger)]">
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
  return 'bg-[color:var(--color-faint)]'
}
