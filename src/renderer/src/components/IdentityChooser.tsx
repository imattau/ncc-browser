import { Check, Smartphone } from 'lucide-react'
import type { IdentityProfile } from '@shared/types'
import { Popover, type PopoverAnchor } from './Popover'

interface IdentityChooserProps {
  identities: IdentityProfile[]
  anchor: PopoverAnchor | null
  busy: boolean
  error: string | null
  onClose: () => void
  onSelect: (id: string) => void
}

export function IdentityChooser({
  identities,
  anchor,
  busy,
  error,
  onClose,
  onSelect
}: IdentityChooserProps) {
  return (
    <Popover
      title="Choose identity"
      subtitle="Select the key used for new NIP-07 requests."
      anchor={anchor}
      widthPx={360}
      testId="identity-chooser"
      onClose={onClose}
    >
      <div className="space-y-1">
        {identities.map((identity) => (
          <button
            key={identity.id}
            type="button"
            disabled={busy}
            aria-current={identity.active ? 'true' : undefined}
            onClick={() => onSelect(identity.id)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[color:var(--color-hover)] disabled:opacity-50"
          >
            {identity.mode === 'nip46' ? (
              <Smartphone className="h-4 w-4 shrink-0 text-[color:var(--color-accent)]" />
            ) : (
              <span className="h-4 w-4 shrink-0 rounded-full border border-[color:var(--color-line)]" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-ui-10 text-[color:var(--color-text-strong)]">
                {identity.npub ?? identity.id}
              </span>
              <span className="mt-0.5 block text-ui-10 text-[color:var(--color-muted)]">
                {identity.mode === 'nip46' ? 'Remote signer' : 'Local key'}
                {identity.isDefault ? ' · Default' : ''}
              </span>
            </span>
            {identity.active ? (
              <Check className="h-4 w-4 shrink-0 text-[color:var(--color-accent)]" />
            ) : null}
          </button>
        ))}
        {error ? (
          <p role="alert" className="px-2.5 py-2 text-ui-10 text-[color:var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </div>
    </Popover>
  )
}
