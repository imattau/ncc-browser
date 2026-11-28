function sameRelays(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(relay => right.includes(relay))
}

/** Split relay metadata changes into commits this account may make and groups
 * whose shared relay list is controlled by another account's admin role. */
export function planGroupRelayUpdates(groups, accountPubkey, relays) {
  const update = []
  const adminRequired = []
  for (const group of groups) {
    const current = group.snapshot.groupData?.relays || []
    if (!current.length || sameRelays(current, relays)) continue
    const name = group.snapshot.groupData?.name || group.idStr
    const admins = group.snapshot.groupData?.adminPubkeys || []
    if (admins.includes(accountPubkey)) update.push({ group, name })
    else adminRequired.push(name)
  }
  return { update, adminRequired }
}
