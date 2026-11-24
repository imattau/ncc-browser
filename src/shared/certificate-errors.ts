export type CertificateErrorCode =
  | 'certificate-date-invalid'
  | 'certificate-untrusted'
  | 'certificate-name-mismatch'
  | 'certificate-revoked'
  | 'certificate-invalid'

export interface CertificateErrorInfo {
  code: CertificateErrorCode
  /** Chromium's diagnostic token, retained for the details view. */
  rawError: string
}

/** Convert Chromium's network error text into a small, stable UI-facing category. */
export function certificateErrorFromDescription(description: string): CertificateErrorInfo | null {
  const match = description.match(/\bERR_CERT_[A-Z0-9_]+\b/i)
  if (!match) return null

  const rawError = `net::${match[0].toUpperCase()}`
  const code: CertificateErrorCode =
    rawError === 'net::ERR_CERT_DATE_INVALID'
      ? 'certificate-date-invalid'
      : rawError === 'net::ERR_CERT_AUTHORITY_INVALID'
        ? 'certificate-untrusted'
        : rawError === 'net::ERR_CERT_COMMON_NAME_INVALID'
          ? 'certificate-name-mismatch'
          : rawError === 'net::ERR_CERT_REVOKED'
            ? 'certificate-revoked'
            : 'certificate-invalid'

  return { code, rawError }
}
