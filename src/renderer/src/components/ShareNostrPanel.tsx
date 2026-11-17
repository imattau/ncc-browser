import { useState } from 'react'
import { Popover } from './Popover'

interface ShareNostrPanelProps {
  title: string
  url: string
  npub: string
  onClose: () => void
  onPost: (comment: string) => Promise<{ accepted: number; relays: number; error?: string }>
}

export function ShareNostrPanel({ title, url, npub, onClose, onPost }: ShareNostrPanelProps) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [message, setMessage] = useState('')

  const post = async (): Promise<void> => {
    if (busy || done) return
    setBusy(true)
    setMessage('')
    try {
      const result = await onPost(comment)
      if (result.accepted > 0) {
        setDone(true)
        setMessage(`Posted to ${result.accepted} of ${result.relays} relays.`)
      } else {
        setMessage(`No relay accepted the post${result.error ? `: ${result.error}` : '.'}`)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover title="Share to Nostr" subtitle="Posts publicly as a kind 1 note" testId="share-nostr" onClose={onClose}>
      <div className="space-y-3 p-3">
        <div className="rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-hover-soft)] p-2.5 text-ui-11 text-[color:var(--color-text)]">
          {title && title !== 'New tab' ? <div className="mb-1 font-medium">{title}</div> : null}
          <div className="break-all text-[color:var(--color-muted)]">{url}</div>
        </div>
        <textarea
          aria-label="Add a comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="Add a comment"
          className="w-full resize-y rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-3 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)]"
        />
        <p className="text-ui-10 text-[color:var(--color-muted)]">Posts publicly as {npub.slice(0, 18)}… to your relays.</p>
        {message ? <p role="status" className="text-ui-11 text-[color:var(--color-muted)]">{message}</p> : null}
        <button type="button" disabled={busy || done} onClick={() => void post()} className="w-full rounded-lg bg-[color:var(--color-accent)] px-3 py-2 text-ui-12 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50">
          {busy ? 'Posting…' : done ? 'Posted' : 'Post'}
        </button>
      </div>
    </Popover>
  )
}
