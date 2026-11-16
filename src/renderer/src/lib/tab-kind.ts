import type { TabKind } from '@shared/types'

export const TAB_KIND_LABEL: Record<TabKind, string> = {
  normal: 'Normal tab',
  private: 'Private tab',
  tor: 'Tor tab'
}

/** What the kind promises, in the words the badge tooltip and new-tab page share. */
export const TAB_KIND_SUMMARY: Record<Exclude<TabKind, 'normal'>, string> = {
  private:
    'Cookies, site data, history and downloads for this tab are discarded when the last private tab closes. Your connection is not hidden.',
  tor: 'All traffic from this tab goes through Tor, in its own session that is discarded when the last Tor tab closes. Sites can still recognise you if you sign in.'
}

/** Text and surface tones per kind, so the strip, badge and lists agree. */
export const TAB_KIND_TONE: Record<
  Exclude<TabKind, 'normal'>,
  { text: string; soft: string; border: string; hover: string }
> = {
  private: {
    text: 'text-[color:var(--color-private-text)]',
    soft: 'bg-[color:var(--color-private-soft)]',
    border: 'border-[color:var(--color-private)]/45',
    hover: 'hover:bg-[color:var(--color-private)]/12'
  },
  tor: {
    text: 'text-[color:var(--color-tor-text)]',
    soft: 'bg-[color:var(--color-tor-soft)]',
    border: 'border-[color:var(--color-tor)]/50',
    hover: 'hover:bg-[color:var(--color-tor)]/12'
  }
}
