/**
 * Privileged-scheme registration for every custom scheme the browser owns.
 *
 * Chromium takes the privileged-scheme list once, at startup, and a second
 * `registerSchemesAsPrivileged()` call does not merge with the first: schemes from the
 * earlier call keep their URL syntax (so `standard` still parses and the protocol
 * handler still serves documents) but lose `secure`, `supportFetchAPI`,
 * `corsEnabled` and `allowServiceWorkers`.
 *
 * Registering `ncc` first and `ncc-ext` second left every service page in a
 * non-secure context: no `crypto.subtle`, no CacheStorage, no service workers, and
 * `fetch()` to the page's own origin failing with "Failed to fetch". Apps that boot
 * through any of those (Ditto, npanel) opened their relay sockets and then stalled
 * before subscribing, which looked like broken relays.
 *
 * Keep this the only call site, and add new schemes to the same array.
 */

import { protocol } from 'electron'
import { EXTENSION_SCHEME } from '@shared/extensions'
import { NSITE_SCHEME } from '@shared/nsite-url'
import { NCC_SCHEME } from './protocol'
import { NCCSEARCH_SCHEME } from './nccsearch/protocol'
import { SITE_PUBLISHER_SCHEME } from './site-publisher/protocol'

/** Must run before `app.whenReady()`. */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: NCC_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: true
      }
    },
    {
      scheme: NSITE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: true
      }
    },
    {
      scheme: EXTENSION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    },
    {
      scheme: NCCSEARCH_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        allowServiceWorkers: true
      }
    },
    {
      scheme: SITE_PUBLISHER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}
