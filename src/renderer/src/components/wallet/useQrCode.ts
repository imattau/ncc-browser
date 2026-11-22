import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { messageOf } from '../../lib/format'

/** Render a `bitcoin:` or `lightning:` payload as a QR data URL. */
export function useQrCode(
  value: string,
  scheme: 'bitcoin' | 'lightning',
  onError: (message: string) => void
): string {
  const [qr, setQr] = useState('')

  useEffect(() => {
    if (!value) {
      setQr('')
      return
    }
    void QRCode.toDataURL(`${scheme}:${value}`, {
      width: 300,
      margin: 1,
      color: { dark: '#101418', light: '#ffffff' }
    })
      .then(setQr)
      .catch((error: unknown) => onError(messageOf(error)))
  }, [value, scheme])

  return qr
}
