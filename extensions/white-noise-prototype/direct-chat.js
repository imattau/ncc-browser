// A direct conversation is represented as a two-member MLS group. Match the
// exact account pair so repeated start-chat actions reuse local group state.
export function findDirectChat(groups, accountPubkey, contactPubkey) {
  return groups.find(group => {
    const members = group.snapshot.members || []
    return members.length === 2 && members.includes(accountPubkey) && members.includes(contactPubkey)
  }) || null
}

const pendingByClient = new WeakMap()

export async function createOrReuseDirectChat({ client, relays, address, name, decodeAddress, createGroup }) {
  const contactPubkey = decodeAddress(address)
  const accountPubkey = await client.signer.getPublicKey()
  if (contactPubkey === accountPubkey) {
    throw new Error('This is your own account. To use White Noise on another device, linked-device support is needed; it is not available yet.')
  }
  const pair = [accountPubkey, contactPubkey].sort().join(':')
  let pending = pendingByClient.get(client)
  if (!pending) {
    pending = new Map()
    pendingByClient.set(client, pending)
  }
  const inFlight = pending.get(pair)
  if (inFlight) return inFlight
  const operation = (async () => {
    const existing = findDirectChat(await client.groups.loadAll(), accountPubkey, contactPubkey)
    if (existing) return existing
    return createGroup(client, relays, name || `Chat · ${contactPubkey.slice(0, 8)}`)
  })()
  pending.set(pair, operation)
  try { return await operation }
  finally {
    if (pending.get(pair) === operation) pending.delete(pair)
    if (!pending.size) pendingByClient.delete(client)
  }
}
