/** Unwrap Electron's "Error invoking remote method 'x': Error: msg" wrapping. */
export function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.lastIndexOf('Error: ')
  return marker === -1 ? raw : raw.slice(marker + 7)
}
