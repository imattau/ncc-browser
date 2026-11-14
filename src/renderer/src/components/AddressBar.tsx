import { useEffect, useRef, useState } from 'react'
import { Lock, Search } from 'lucide-react'
import { cn } from '../lib/cn'

interface AddressBarProps {
  value: string
  loading: boolean
  hint: string | null
  onNavigate: (input: string) => void
  onFocusChange?: (focused: boolean) => void
}

export function AddressBar({ value, loading, hint, onNavigate, onFocusChange }: AddressBarProps) {
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
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        focusAddress()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('ncc:focus-address', focusAddress)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('ncc:focus-address', focusAddress)
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
        <Lock className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-muted)]" />
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
          <Search className="h-3.5 w-3.5 shrink-0 text-[#3f4553]" />
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
