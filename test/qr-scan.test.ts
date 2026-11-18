import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import QRCode from 'qrcode'
// @ts-expect-error plain JS module
import { parsePaymentQr } from '../mobile/qr-scan.js'

describe('wallet QR scanning', () => {
  it('extracts the address and amount from payment URIs', () => {
    expect(parsePaymentQr('bitcoin:bc1qxyz?amount=0.001&label=x', 'bitcoin')).toEqual({ address: 'bc1qxyz', amount: '0.001' })
    expect(parsePaymentQr('monero:4Abc?tx_amount=1.5', 'monero')).toEqual({ address: '4Abc', amount: '1.5' })
    expect(parsePaymentQr('  bc1qplain  ', 'bitcoin')).toEqual({ address: 'bc1qplain', amount: '' })
    expect(parsePaymentQr('BITCOIN:bc1q?amount=abc', 'bitcoin')).toEqual({ address: 'bc1q', amount: '' })
  })

  it('decodes a generated wallet QR with jsQR', () => {
    const text = 'monero:4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge'
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
    const scale = 6, margin = 4, n = qr.modules.size, side = (n + margin * 2) * scale
    const data = new Uint8ClampedArray(side * side * 4).fill(255)
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - margin, my = Math.floor(y / scale) - margin
      if (mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(mx, my)) { const i = (y * side + x) * 4; data[i] = data[i + 1] = data[i + 2] = 0 }
    }
    expect(jsQR(data, side, side)?.data).toBe(text)
  })
})
