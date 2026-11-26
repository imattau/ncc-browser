/**
 * Content session isolation for normal, private and full-Tor tabs.
 *
 * Private and Tor partitions have no `persist:` prefix, so Electron keeps their
 * storage in memory. Each session is cleared when its last tab closes.
 */

import { app, session, type Session } from 'electron'
import { TOR_LANGUAGE_LIST } from '@shared/tor-identity'
import type { TabKind } from '@shared/types'
import { brandedUserAgent } from './user-agents'

export const SESSION_PARTITIONS: Record<TabKind, string> = {
  normal: 'persist:ncc-content',
  private: 'ncc-private',
  tor: 'ncc-tor'
}

export const EXTENSION_PARTITION = 'persist:ncc-extensions'

export interface ContentSessions {
  normal: Session
  private: Session
  tor: Session
  extensions: Session
}

export function createContentSessions(): ContentSessions {
  const normal = session.fromPartition(SESSION_PARTITIONS.normal)
  const privateSession = session.fromPartition(SESSION_PARTITIONS.private)
  const tor = session.fromPartition(SESSION_PARTITIONS.tor)
  const extensions = session.fromPartition(EXTENSION_PARTITION)
  for (const value of [normal, privateSession, tor, extensions]) {
    value.setSpellCheckerEnabled(false)
  }
  for (const value of [session.defaultSession, normal, privateSession, extensions]) {
    value.setUserAgent(brandedUserAgent())
  }
  // The app-wide default is the anonymous agent; see user-agents.ts.
  tor.setUserAgent(app.userAgentFallback, TOR_LANGUAGE_LIST)
  return { normal, private: privateSession, tor, extensions }
}

export function sessionFor(sessions: ContentSessions, kind: TabKind): Session {
  return sessions[kind]
}

export function partitionFor(kind: TabKind): string {
  return SESSION_PARTITIONS[kind]
}

export async function clearContentSession(value: Session): Promise<void> {
  await value.clearStorageData()
  await value.clearCache()
  await value.clearAuthCache()
  await value.clearHostResolverCache()
}
