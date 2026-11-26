import { describe, expect, it } from 'vitest'
import { decodeBolt11Invoice } from '../src/shared/bolt11'

const fixedInvoice = 'lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpu9qrsgqhtjpauu9ur7fw2thcl4y9vfvh4m9wlfyz2gem29g5ghe2aak2pm3ps8fdhtceqsaagty2vph7utlgj48u0ged6a337aewvraedendscp573dxr'
const noAmountInvoice = 'lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql'

describe('BOLT11 invoice review', () => {
  it('verifies the signature and extracts amount, network, and description', () => {
    const decoded = decodeBolt11Invoice(fixedInvoice, 1496314659)
    expect(decoded).toMatchObject({
      network: 'mainnet',
      amountMsat: '250000000',
      description: 'ナンセンス 1杯',
      payee: expect.stringMatching(/^[0-9a-f]{66}$/),
      expired: false
    })
  })

  it('marks invoices without an encoded amount and expired invoices correctly', () => {
    expect(decodeBolt11Invoice(noAmountInvoice, 1496318258)).toMatchObject({ amountMsat: null, expired: true })
  })

  it('rejects a bad checksum and a mixed-case invoice', () => {
    const corrupted = `${fixedInvoice.slice(0, -1)}${fixedInvoice.endsWith('q') ? 'p' : 'q'}`
    expect(() => decodeBolt11Invoice(corrupted)).toThrow(/checksum/i)
    expect(() => decodeBolt11Invoice(`lnbc${fixedInvoice.slice(4).toUpperCase()}`)).toThrow(/valid Lightning invoice/i)
  })
})
