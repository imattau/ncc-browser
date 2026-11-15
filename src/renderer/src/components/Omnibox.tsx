import { Clock, Fingerprint, Globe, Layers, Search, Star } from 'lucide-react'
import type { ReactNode } from 'react'
import type { OmniboxSuggestion, OmniboxSuggestionIcon } from '@shared/types'
import { cn } from '../lib/cn'

const ICONS: Record<OmniboxSuggestionIcon, typeof Search> = {
  search: Search,
  web: Globe,
  ncc: Fingerprint,
  star: Star,
  clock: Clock,
  tab: Layers
}

interface OmniboxProps {
  id: string
  suggestions: OmniboxSuggestion[]
  activeIndex: number
  query: string
  hint: string | null
  onHover: (index: number) => void
  onPick: (suggestion: OmniboxSuggestion) => void
}

export function Omnibox({
  id,
  suggestions,
  activeIndex,
  query,
  hint,
  onHover,
  onPick
}: OmniboxProps) {
  if (suggestions.length === 0 && !hint) return null

  return (
    <div
      id={id}
      role="listbox"
      data-omnibox
      className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[340px] overflow-y-auto rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-panel-raised)] py-1 shadow-[0_24px_60px_rgba(0,0,0,0.45)]"
    >
      {suggestions.map((suggestion, index) => {
        const Icon = ICONS[suggestion.icon] ?? Globe
        const active = index === activeIndex
        return (
          <button
            key={suggestion.id}
            type="button"
            id={`${id}-option-${index}`}
            role="option"
            aria-selected={active}
            data-omnibox-suggestion={suggestion.kind}
            data-omnibox-active={active ? 'true' : 'false'}
            data-omnibox-url={suggestion.url}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => onHover(index)}
            onClick={() => onPick(suggestion)}
            className={cn(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left',
              active ? 'bg-[color:var(--color-accent)]/10' : 'hover:bg-white/[0.05]'
            )}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color:var(--color-line)] bg-[#0e1016]',
                iconTone(suggestion.kind)
              )}
            >
              <Icon className="h-3 w-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-[#e7e9ef]">
                {highlight(suggestion.title, query)}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] text-[color:var(--color-muted)]">
                <span className="shrink-0">{suggestion.detail}</span>
                {suggestion.url ? (
                  <>
                    <span className="text-[#3f4553]">·</span>
                    <span className="truncate font-mono">{highlight(suggestion.url, query)}</span>
                  </>
                ) : null}
              </span>
            </span>
            {active ? (
              <span className="shrink-0 text-[9.5px] text-[#5d6575]">Enter</span>
            ) : null}
          </button>
        )
      })}

      {hint ? (
        <p
          data-omnibox-hint
          className="border-t border-[color:var(--color-line)] px-3 py-2 text-[11px] text-[color:var(--color-danger)]"
        >
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function iconTone(kind: OmniboxSuggestion['kind']): string {
  switch (kind) {
    case 'action':
      return 'text-[color:var(--color-accent)]'
    case 'bookmark':
      return 'text-[color:var(--color-warn)]'
    case 'tab':
      return 'text-[#a78bfa]'
    case 'service':
      return 'text-[#c4b5fd]'
    default:
      return 'text-[color:var(--color-muted)]'
  }
}

/** Bold the first case-insensitive occurrence of the typed text. */
function highlight(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const index = text.toLowerCase().indexOf(needle.toLowerCase())
  if (index === -1) return text
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-[color:var(--color-accent)]/25 text-inherit">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  )
}
