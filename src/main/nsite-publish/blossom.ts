/**
 * NIP-5A blob uploads (BUD-02) from the main process.
 *
 * The page version in `site-publisher/` has to work around browser CORS and uses the
 * NIP-07 signer. Here the same protocol runs with the durable identity and Node's
 * fetch, so the only network requirement is a Blossom server that accepts the key.
 */

import { createHash } from 'node:crypto'
import type { Event, EventTemplate } from 'nostr-tools'
import { mimeForPath } from '../nsite/mime'

const AUTH_KIND = 24242
const AUTH_TTL_SECONDS = 600
const UPLOAD_TIMEOUT_MS = 120_000
const READ_TIMEOUT_MS = 30_000

export interface NsiteSigner {
  signEvent(template: EventTemplate): Promise<Event>
}

export interface ServerOutcome {
  server: string
  ok: boolean
  message: string
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** BUD-11 wants base64url without padding; standard base64 is rejected by some servers. */
export function toBase64UrlUtf8(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

async function authHeader(hash: string, signer: NsiteSigner): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const event = await signer.signEvent({
    kind: AUTH_KIND,
    created_at: now,
    tags: [
      ['t', 'upload'],
      ['expiration', String(now + AUTH_TTL_SECONDS)],
      ['x', hash]
    ],
    content: 'Upload an nsite file'
  })
  return `Nostr ${toBase64UrlUtf8(JSON.stringify(event))}`
}

export async function blobExists(server: string, hash: string): Promise<boolean> {
  try {
    const response = await fetch(`${server.replace(/\/+$/, '')}/${hash}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS)
    })
    return response.ok
  } catch {
    return false
  }
}

/** Uploads one blob. `already-exists` is a success: the address is the hash. */
export async function uploadBlob(options: {
  server: string
  hash: string
  bytes: Uint8Array
  path: string
  signer: NsiteSigner
}): Promise<ServerOutcome> {
  const server = options.server.replace(/\/+$/, '')
  try {
    if (await blobExists(server, options.hash)) {
      return { server, ok: true, message: 'already stored' }
    }
    const authorization = await authHeader(options.hash, options.signer)
    // BUD-02 is PUT /upload with the hash in X-Sha-256, not PUT /<hash>.
    const response = await fetch(`${server}/upload`, {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'Content-Type': mimeForPath(options.path),
        'X-Sha-256': options.hash
      },
      body: options.bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })
    if (response.ok || response.status === 409) {
      return { server, ok: true, message: `uploaded (${response.status})` }
    }
    const reason = response.headers.get('x-reason')
    const detail = (reason ?? (await response.text().catch(() => '')))
      .replace(/\s+/g, ' ')
      .slice(0, 160)
    return { server, ok: false, message: `HTTP ${response.status}${detail ? `: ${detail}` : ''}` }
  } catch (error) {
    return {
      server,
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Downloads a blob and checks its bytes against the manifest hash. */
export async function verifyBlob(server: string, hash: string): Promise<boolean> {
  try {
    const response = await fetch(`${server.replace(/\/+$/, '')}/${hash}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS)
    })
    if (!response.ok) return false
    const bytes = new Uint8Array(await response.arrayBuffer())
    return sha256Hex(bytes) === hash
  } catch {
    return false
  }
}
