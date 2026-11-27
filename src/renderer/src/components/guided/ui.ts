/** Class names shared by the guided publishing screens. */
export const PRIMARY_BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-3.5 py-2 text-ui-12 font-semibold text-[color:var(--color-on-accent)] disabled:opacity-50'
export const SECONDARY_BUTTON =
  'inline-flex items-center gap-1.5 rounded-lg border border-[color:var(--color-line)] px-3.5 py-2 text-ui-12 text-[color:var(--color-text)] hover:bg-[color:var(--color-hover)] disabled:opacity-50'
export const QUIET_BUTTON =
  'rounded-lg px-2.5 py-2 text-ui-11 text-[color:var(--color-muted)] hover:bg-[color:var(--color-hover)] disabled:opacity-50'
export const FIELD_LABEL = 'block text-ui-11 text-[color:var(--color-text)]'
export const FIELD_HINT = 'mt-1 block text-ui-105 leading-relaxed text-[color:var(--color-muted)]'
export const INPUT =
  'mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-ink)] px-2.5 py-2 text-ui-12 text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-accent)] disabled:opacity-50'
/** The base styles reset borders, which drops Chromium to a green bar that ignores `accent-color`. */
export const PROGRESS_BAR =
  'mt-1 block h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-[color:var(--color-line)] [&::-webkit-progress-value]:bg-[color:var(--color-accent)]'
