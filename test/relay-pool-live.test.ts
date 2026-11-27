/**
 * The real pool against a live and a dead relay. Opt-in: needs `nak serve --port 10547`
 * (NCC_SYNC_RELAY=ws://127.0.0.1:10547).
 */
import { describe, expect, it } from 'vitest'
import { RelayPool } from '../src/main/relay/pool'
import { RelayPinStore } from '../src/main/relay/socket'

const live = process.env.NCC_SYNC_RELAY

describe.skipIf(!live)('RelayPool.queryAuthReport', () => {
  it('counts a reachable relay that holds nothing as an answer, and a dead one as none', async () => {
    const pool = new RelayPool({ pins: new RelayPinStore(), proxy: () => null })
    const filter = { kinds: [30078], limit: 1 }
    const up = await pool.queryAuthReport([live as string], filter)
    expect(up.answered).toBe(1)
    const down = await pool.queryAuthReport(['ws://127.0.0.1:1'], filter)
    expect(down.answered).toBe(0)
    const mixed = await pool.queryAuthReport([live as string, 'ws://127.0.0.1:1'], filter)
    expect(mixed.answered).toBe(1)
    expect(mixed.unanswered).toEqual(['ws://127.0.0.1:1'])
    // One relay written two ways is one relay, not one that failed to answer.
    const twice = await pool.queryAuthReport([live as string, `${live}/`], filter)
    expect(twice).toMatchObject({ asked: 1, answered: 1 })
    pool.closeAll()
  }, 30_000)
})
