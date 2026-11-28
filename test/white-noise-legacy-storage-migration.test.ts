import { describe, expect, it } from 'vitest'
import { planLegacyAccountMigration } from '../extensions/white-noise-prototype/legacy-storage-migration.js'

describe('White Noise legacy account storage migration', () => {
  it('moves rewind state with the legacy group and message stores', () => {
    const original = {
      'marmot:groups:group-a': { epoch: 7 },
      'marmot:rewind:group-a': { branches: ['old-epoch'] },
      'marmot:keypackages:local-signature-key': { publicKey: [1, 2] },
      'marmot:history:group-a:rumors': { count: 2 },
      'marmot:clientId': 'legacy-client',
      'marmot:chat-ui:group-a': { pinned: true },
      'marmot:account:other-account:groups:group-b': { epoch: 3 }
    }

    expect(planLegacyAccountMigration(original, 'account-a', 'account:account-a:')).toEqual({
      'marmot:account:account-a:groups:group-a': original['marmot:groups:group-a'],
      'marmot:account:account-a:rewind:group-a': original['marmot:rewind:group-a'],
      'marmot:account:account-a:keypackages:local-signature-key': original['marmot:keypackages:local-signature-key'],
      'marmot:account:account-a:history:group-a:rumors': original['marmot:history:group-a:rumors'],
      'marmot:account:account-a:clientId': 'legacy-client'
    })
  })

  it('refuses to copy the old shared namespace when NCC recorded another account', () => {
    expect(planLegacyAccountMigration({
      connectedSignerPubkey: 'account-b',
      'marmot:groups:group-a': { epoch: 7 }
    }, 'account-a', 'account:account-a:')).toBeNull()
  })
})
