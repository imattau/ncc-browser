/**
 * Content session isolation for normal, private and full-Tor tabs.
 *
 * Private and Tor partitions have no `persist:` prefix, so Electron keeps their
 * storage in memory. Each session is cleared when its last tab closes.
 */

import { session, type Session } from 'electron'
import type { TabKind } from '@shared/types'

export const SESSION_PARTITIONS: Record<TabKind, string> = {
  normal: 'persist:ncc-content',
  private: 'ncc-private',
  tor: 'ncc-tor'
}

export interface ContentSessions {
  normal: Session
  private: Session
  tor: Session
}

export function createContentSessions(): ContentSessions {
  const normal = session.fromPartition(SESSION_PARTITIONS.normal)
  const privateSession = session.fromPartition(SESSION_PARTITIONS.private)
  const tor = session.fromPartition(SESSION_PARTITIONS.tor)
  for (const value of [normal, privateSession, tor]) {
    value.setSpellCheckerEnabled(false)
  }
  return { normal, private: privateSession, tor }
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
