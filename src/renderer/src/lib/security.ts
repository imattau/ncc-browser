import type { NavState } from '@shared/types'
import { clearnetState } from './clearnet'

export type SecurityTone = 'ok' | 'warn' | 'danger' | 'muted'

export interface SecuritySummary {
  tone: SecurityTone
  label: string
  host: string
  anchorState: string
  tooltip: string
  clickable: boolean
}

/** One summary for the address-bar padlock, shared by the button and its panel. */
export function securitySummary(state: NavState): SecuritySummary {
  const security = state.security
  const failure = state.failure
  const anchor = security?.anchor ?? null

  if (failure) {
    return {
      tone: 'danger',
      label: 'failure',
      host: security?.host ?? hostOf(state.url || state.displayUrl),
      anchorState: 'none',
      tooltip: `Security problem: ${failure.code} — click for details`,
      clickable: true
    }
  }

  if (state.mode === 'blank') {
    return {
      tone: 'muted',
      label: 'blank',
      host: '',
      anchorState: 'none',
      tooltip: 'New tab',
      clickable: false
    }
  }

  if (state.mode === 'web') {
    const web = clearnetState(state.url || state.displayUrl)
    return {
      tone: web.tone,
      label: web.label,
      host: web.host,
      anchorState: 'none',
      tooltip:
        web.label === 'secure'
          ? `Secure HTTPS · ${web.host} — click for details`
          : web.label === 'insecure'
            ? `Not secure · HTTP · ${web.host} — click for details`
            : 'Clearnet page — click for details',
      clickable: true
    }
  }

  const tone: SecurityTone = !security
    ? 'muted'
    : security.transport === 'pinned-tls' || security.transport === 'tls'
      ? 'ok'
      : security.transport === 'plaintext'
        ? 'warn'
        : 'muted'

  const label = !security ? 'ncc' : security.transport
  const anchorState = anchor?.status ?? 'none'

  return {
    tone,
    label,
    host: security?.host ?? '',
    anchorState,
    tooltip: !security
      ? 'NCC page — resolution details'
      : `${transportLabel(security.transport)} · ${security.host}${anchor ? ` · NCC-02 ${anchor.status}` : ''} — click for details`,
    clickable: true
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function transportLabel(transport: string): string {
  if (transport === 'pinned-tls') return 'Pinned TLS'
  if (transport === 'tls') return 'TLS'
  if (transport === 'plaintext') return 'Plaintext'
  return 'Unknown transport'
}
