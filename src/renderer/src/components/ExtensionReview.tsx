import { useEffect, useRef, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { ExtensionAccessItem, ExtensionInstallReview } from '@shared/extensions'

/** The approval step between choosing a package and installing it. */
export function ExtensionReview({
  review,
  busy,
  onApprove,
  onCancel
}: {
  review: ExtensionInstallReview
  busy: boolean
  onApprove: (privateTabs: boolean) => void
  onCancel: () => void
}) {
  const [privateTabs, setPrivateTabs] = useState(review.privateTabs)
  const panel = useRef<HTMLElement>(null)
  const { replaces } = review

  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'nearest' })
    panel.current?.focus()
  }, [])

  return (
    <section
      ref={panel}
      tabIndex={-1}
      aria-labelledby="extension-review-title"
      data-extension-review
      className="rounded-xl border border-[color:var(--color-warn)] bg-[color:var(--color-panel-raised)] p-4"
    >
      <h3
        id="extension-review-title"
        className="flex items-center gap-1.5 text-ui-12 font-semibold text-[color:var(--color-text-strong)]"
      >
        <ShieldAlert className="h-3.5 w-3.5 text-[color:var(--color-warn)]" />
        {replaces ? 'Replace with' : 'Install'} {review.name} {review.version}?
      </h3>
      {replaces ? (
        <p className="mt-1 text-ui-11 text-[color:var(--color-muted)]">
          Replaces {replaces.name} {replaces.version} and keeps its saved data.
        </p>
      ) : null}
      <p className="mt-1 break-all font-mono text-ui-105 text-[color:var(--color-muted)]">
        {review.sourcePath}
      </p>
      {review.description ? (
        <p className="mt-1 text-ui-11 text-[color:var(--color-muted)]">{review.description}</p>
      ) : null}

      <AccessList title="Permissions" items={review.permissions} empty="No special permissions." />
      <AccessList title="Websites" items={review.sites} empty="No website access." />

      {review.notices.length > 0 ? (
        <p className="mt-2 text-ui-105 leading-relaxed text-[color:var(--color-warn)]">
          {review.notices.join(' · ')}
        </p>
      ) : null}

      <label className="mt-3 flex cursor-pointer items-center gap-1.5 text-ui-11 text-[color:var(--color-muted)]">
        <input
          type="checkbox"
          checked={privateTabs}
          onChange={(event) => setPrivateTabs(event.target.checked)}
          className="h-3 w-3 accent-[color:var(--color-accent)]"
        />
        Run in private tabs
      </label>

      <p className="mt-2 text-ui-105 text-[color:var(--color-faint)]">
        This package is not signed. Only install code you trust.
      </p>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-extension-review-cancel
          disabled={busy}
          onClick={onCancel}
          className="rounded-lg border border-[color:var(--color-line)] px-2.5 py-1.5 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-text-strong)] disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          data-extension-review-approve
          disabled={busy}
          onClick={() => onApprove(privateTabs)}
          className="rounded-lg bg-[color:var(--color-accent)] px-2.5 py-1.5 text-ui-11 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-40"
        >
          {replaces ? 'Replace' : 'Install'}
        </button>
      </div>
    </section>
  )
}

function AccessList({
  title,
  items,
  empty
}: {
  title: string
  items: ExtensionAccessItem[]
  empty: string
}) {
  return (
    <div className="mt-3">
      <p className="text-ui-11 font-semibold text-[color:var(--color-text-strong)]">{title}</p>
      {items.length === 0 ? (
        <p className="text-ui-105 text-[color:var(--color-faint)]">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-ui-11 text-[color:var(--color-muted)]">
          {/* New access first, so an update cannot hide it at the end of a long list. */}
          {[...items]
            .sort((a, b) => Number(b.added) - Number(a.added))
            .map((item) => (
              <li key={item.id} className="break-all">
                {item.added ? (
                  <strong className="mr-1.5 text-[color:var(--color-warn)]">New</strong>
                ) : null}
                {item.label}
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}
