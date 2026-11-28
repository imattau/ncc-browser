const LEGACY_ACCOUNT_STORES = ['groups', 'rewind', 'keypackages', 'invites', 'ingest', 'history:']

/**
 * Build the per-account copy of the companion's pre-account storage namespace.
 * The legacy namespace belongs to the previously connected signer only, so do
 * not copy it after NCC has recorded a different active account.
 */
export function planLegacyAccountMigration(all, pubkey, accountPrefix) {
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null
  if (all.connectedSignerPubkey && all.connectedSignerPubkey !== pubkey) return null

  const migrated = {}
  for (const [key, value] of Object.entries(all)) {
    const prefix = LEGACY_ACCOUNT_STORES.find(item => key.startsWith(`marmot:${item}`))
    if (!prefix) continue
    const suffix = key.slice(`marmot:${prefix}`.length)
    migrated[`marmot:${accountPrefix}${prefix}${suffix}`] = value
  }
  if (all['marmot:clientId']) migrated[`marmot:${accountPrefix}clientId`] = all['marmot:clientId']
  return migrated
}
