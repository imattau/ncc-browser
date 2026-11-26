import { describe, expect, it } from 'vitest'
import { anonymiseTorHeaders, genericUserAgent } from '../src/shared/tor-identity'

const ELECTRON =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) NostrNavigator/0.47.19 Chrome/156.0.8078.100 Electron/45.3.2 Safari/537.36'

describe('what a Tor tab says about the browser', () => {
  it.each([
    ['linux', 'X11; Linux x86_64'],
    ['win32', 'Windows NT 10.0; Win64; x64'],
    ['darwin', 'Macintosh; Intel Mac OS X 10_15_7']
  ] as const)('is an ordinary Chrome on %s', (platform, system) => {
    expect(genericUserAgent(ELECTRON, platform)).toBe(
      `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36`
    )
  })

  it('drops client hints and the device language, whatever their case', () => {
    expect(
      anonymiseTorHeaders({
        'User-Agent': 'x',
        'sec-ch-ua': '"Chromium";v="156"',
        'Sec-CH-UA-Platform': '"Linux"',
        'accept-language': 'fr-FR,fr;q=0.9',
        'Sec-Fetch-Mode': 'navigate',
        Cookie: 'a=1'
      })
    ).toEqual({
      'User-Agent': 'x',
      'Sec-Fetch-Mode': 'navigate',
      Cookie: 'a=1',
      'Accept-Language': 'en-US,en;q=0.9'
    })
  })
})
