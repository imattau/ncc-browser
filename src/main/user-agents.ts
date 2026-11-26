/**
 * Which user agent each part of the browser sends.
 *
 * Electron builds `NostrNavigator/<version>` into its default from the app name, and
 * sites use it to recognise this browser. Service workers ignore a session's user agent
 * and report the app-wide default, so that default has to be the anonymous one for a
 * Tor tab's workers to be anonymous; every other session is given the branded agent.
 * The cost is that service workers in ordinary tabs report the anonymous one too.
 */

import { app } from 'electron'
import { genericUserAgent } from '@shared/tor-identity'

let branded = ''

/** Call after the app is named and before any session exists. */
export function installDefaultUserAgent(): void {
  branded = app.userAgentFallback
  app.userAgentFallback = genericUserAgent(branded, process.platform)
}

export function brandedUserAgent(): string {
  return branded
}
