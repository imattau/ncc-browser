/**
 * Display helpers shared by the chrome renderer. Pure and framework-free so they can
 * be unit-tested without a DOM (see `test/renderer-format.test.ts`).
 */

/** Unwrap Electron's "Error invoking remote method 'x': Error: msg" wrapping. */
export function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}

/** "just now" / "5 min ago" / "3 h ago" / "2 d ago" from a unix-seconds timestamp. */
export function relativeSeconds(seconds: number | undefined): string {
  if (!seconds) return 'not published'
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (delta < 60) return 'just now'
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`
  if (delta < 86_400) return `${Math.floor(delta / 3600)} h ago`
  return `${Math.floor(delta / 86_400)} d ago`
}

/** "12 min left" / "3 h left" / "2 d left"; "expired" once the timestamp has passed. */
export function untilSeconds(expiresAt: number): string {
  const seconds = expiresAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'expired'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min left`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h left`
  return `${Math.round(seconds / 86_400)} d left`
}

/** Compact "12 min" / "3 h" / "2 d" for dense rows such as relay entries. */
export function durationFromNow(expiresAt: number): string {
  const seconds = expiresAt - Math.floor(Date.now() / 1000)
  if (seconds <= 0) return 'expired'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

/**
 * Truncate an npub or hex key to `head…tail`. Widths stay a call-site decision so each
 * surface keeps the density it was designed for.
 */
export function shortIdentity(value: string, head = 12, tail = 6): string {
  const trimmed = value.trim()
  return trimmed.length > head + tail + 6
    ? `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`
    : trimmed
}
