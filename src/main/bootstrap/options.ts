import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nip19 } from 'nostr-tools'
import { signerFromSecret, type LocatorSigner } from '../ncc/resolver'

/** Packaged Tor binary, with a repo-local resources directory for development. */
export function torBinaryPath(): string | null {
  const override = process.env.NCC_TOR_BINARY?.trim()
  if (override) return existsSync(override) ? override : null

  const platform =
    process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
  const binary = process.platform === 'win32' ? 'tor.exe' : 'tor'
  const base = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')
  const candidates = app.isPackaged
    ? [join(base, 'tor', 'tor', binary)]
    : [join(base, 'tor', `${platform}-${process.arch}`, 'tor', binary)]
  return candidates.find(existsSync) ?? null
}

/** A URL passed on the command line opens on launch. */
export function findStartupAddress(): string | null {
  return process.argv.find((arg) => /^(ncc|nsite|https?):\/\//i.test(arg)) ?? null
}

/**
 * Optional decryption key for encrypted locators. v0.1 ships without a keychain and
 * without a signer UI; this exists so targeted records can be tested deliberately.
 */
export function locatorSignerFromEnv(): LocatorSigner | null {
  const raw = process.env.NCC_LOCATOR_NSEC?.trim()
  if (!raw) return null

  try {
    const secret = raw.startsWith('nsec1') ? decodeNsec(raw) : hexToBytes(raw)
    if (!secret || secret.length !== 32) throw new Error('expected 32-byte secret key')
    console.warn('[ncc] decrypting locators with NCC_LOCATOR_NSEC (development only)')
    return signerFromSecret(secret)
  } catch (error) {
    console.warn('[ncc] ignoring NCC_LOCATOR_NSEC:', error instanceof Error ? error.message : error)
    return null
  }
}

function decodeNsec(value: string): Uint8Array | null {
  const decoded = nip19.decode(value)
  return decoded.type === 'nsec' ? (decoded.data as Uint8Array) : null
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}
