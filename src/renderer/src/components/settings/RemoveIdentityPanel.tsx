import { useEffect, useRef, useState } from 'react'
import type { IdentityRemovalScope } from '@shared/sync-status'
import { DANGER_BUTTON, SECONDARY_BUTTON } from '../guided/ui'

interface RemoveIdentityPanelProps {
  /** Identity sync is on, so there is a choice to make. */
  syncing: boolean
  /** This key protects the synced list. */
  protectsList: boolean
  busy: boolean
  onRemove: (scope: IdentityRemovalScope) => void
  onCancel: () => void
}

/** What removing a saved key will do, said before it is done. */
export function RemoveIdentityPanel({
  syncing,
  protectsList,
  busy,
  onRemove,
  onCancel
}: RemoveIdentityPanelProps) {
  const [scope, setScope] = useState<IdentityRemovalScope>('device')
  const heading = useRef<HTMLParagraphElement>(null)
  useEffect(() => heading.current?.focus(), [])

  if (protectsList) {
    return (
      <div data-remove-identity="blocked" className="space-y-2 rounded-lg border border-[color:var(--color-warn)]/40 p-3 text-ui-115 text-[color:var(--color-muted)]">
        <p ref={heading} tabIndex={-1} className="text-ui-12 font-semibold text-[color:var(--color-text-strong)] outline-none">
          This identity can’t be removed yet
        </p>
        <p>
          It protects your synced identity list. First turn off identity sync, or make another
          identity the default and then migrate the list in Settings → Sync.
        </p>
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
          Close
        </button>
      </div>
    )
  }

  const choice = (value: IdentityRemovalScope, title: string, text: string) => (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="radio"
        name="identity-removal-scope"
        value={value}
        checked={scope === value}
        onChange={() => setScope(value)}
        className="mt-0.5 h-4 w-4 accent-[color:var(--color-accent)]"
      />
      <span>
        <span className="block text-ui-12 text-[color:var(--color-text-strong)]">{title}</span>
        <span className="block">{text}</span>
      </span>
    </label>
  )

  return (
    <div data-remove-identity className="space-y-2.5 rounded-lg border border-[color:var(--color-danger)]/40 p-3 text-ui-115 leading-relaxed text-[color:var(--color-muted)]">
      <p ref={heading} tabIndex={-1} className="text-ui-12 font-semibold text-[color:var(--color-text-strong)] outline-none">
        Remove this identity?
      </p>
      <p>
        This deletes its key from this device. If this is the only copy, it can’t be recovered, so
        back it up first if you may need it.
      </p>
      {syncing ? (
        <div role="radiogroup" aria-label="What to remove" className="space-y-2">
          {choice(
            'device',
            'Remove from this device only',
            'Sync won’t add it back here. It stays in your synced list and on your other devices.'
          )}
          {choice(
            'everywhere',
            'Also stop syncing it everywhere',
            'It is taken out of your synced list. Other devices ask before deleting their own copy. Update all your devices, because older versions can add it back for a time.'
          )}
        </div>
      ) : (
        <p>If you use identity sync later, it won’t be added back to this device.</p>
      )}
      {syncing && scope === 'everywhere' ? (
        <p>
          This can’t revoke the key or erase every old copy. If someone else has the key, stop using
          it.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-remove-identity-confirm
          disabled={busy}
          onClick={() => onRemove(syncing ? scope : 'device')}
          className={DANGER_BUTTON}
        >
          Remove
        </button>
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  )
}
