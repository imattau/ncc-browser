export interface PasskeyCreationOptions {
  challenge: string
  rp?: { id?: string; name?: string }
  user?: { id?: string; name?: string; displayName?: string }
  pubKeyCredParams?: Array<{ type: string; alg: number }>
  authenticatorSelection?: {
    residentKey?: string
    requireResidentKey?: boolean
  }
}

export interface PasskeyJwk {
  [key: string]: string | boolean | string[] | undefined
  kty?: string
  crv?: string
  x?: string
  y?: string
  d?: string
  ext?: boolean
  key_ops?: string[]
  alg?: string
}

export interface VaultPasskeyRecord {
  credentialId: string
  rpId: string
  userHandle: string
  userName: string
  userDisplayName: string
  privateKeyJwk: PasskeyJwk
  publicKeyJwk: PasskeyJwk
  signCount: number
  discoverable: boolean
}

export interface PasskeyCreationResponse {
  id: string
  rawId: string
  type: 'public-key'
  clientDataJSON: string
  attestationObject: string
  publicKey: string
  transports: string[]
}

export interface PasskeyAssertionResponse {
  id: string
  rawId: string
  type: 'public-key'
  clientDataJSON: string
  authenticatorData: string
  signature: string
  userHandle: string | null
}

export function validateRpId(origin: string, input?: string): string
export function makeVaultPasskey(
  options: PasskeyCreationOptions,
  origin: string
): Promise<{ record: VaultPasskeyRecord; response: PasskeyCreationResponse }>
export function makeVaultAssertion(
  record: VaultPasskeyRecord,
  challenge: string,
  origin: string,
  userVerification?: string
): Promise<PasskeyAssertionResponse>
