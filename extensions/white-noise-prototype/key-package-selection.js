const lifetimeError = 'KeyPackage lifetime exceeds cap or is not current'
const legacyCompatibilityError = 'leaf carries no app_data_dictionary extension'

/**
 * Pick the newest published KeyPackage the current Marmot client can validate.
 * A contact may have several independent replaceable package slots, and their
 * publication timestamps do not guarantee that every slot is still usable.
 */
export async function selectUsableKeyPackage(events, buildInviteIntent) {
  const unique = new Map()
  for (const event of events || []) {
    if (event?.id && !unique.has(event.id)) unique.set(event.id, event)
  }
  const candidates = [...unique.values()].sort((left, right) => right.created_at - left.created_at)
  if (!candidates.length) {
    throw new Error('No invite key package found. Ask this contact to connect and publish one first.')
  }

  const failures = []
  for (const keyPackage of candidates) {
    try {
      return { keyPackage, intent: await buildInviteIntent(keyPackage) }
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.every(error => error instanceof Error && error.message.includes(legacyCompatibilityError))) {
    throw new Error('This contact’s available key packages are incompatible with this Marmot v2 group. Ask them to update White Noise and publish a fresh key package.')
  }
  if (failures.every(error => error instanceof Error && error.message.includes(lifetimeError))) {
    throw new Error('The contact’s available invite keys are expired or not yet valid. Ask them to publish a new key package, then try again.')
  }
  const firstError = failures.find(error => error instanceof Error)
  throw firstError || new Error('The contact has no usable invite key package.')
}
