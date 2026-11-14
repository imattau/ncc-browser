import { SimplePool, verifyEvent, type Event } from 'nostr-tools'
import type { EventTemplate } from './locator'
import type { Nip07Signer } from './signer-types'

export interface RelayReport {
  relay: string
  ok: boolean
  error?: string
  eventIds: string[]
}

/** Sign every template with NIP-07 and verify the result before it reaches a relay. */
export async function signTemplates(
  signer: Nip07Signer,
  templates: EventTemplate[]
): Promise<Event[]> {
  const events = await Promise.all(
    templates.map(async (template) => {
      const event = await signer.signEvent(template)
      if (!verifyEvent(event)) throw new Error('The signer returned an invalid signature')
      return event
    })
  )
  return events
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay timed out')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * Publish every event to every relay, reporting per-relay acceptance. One slow or
 * rejecting relay does not hide the status of the others.
 */
export async function publishEvents(
  relays: string[],
  events: Event[],
  timeoutMs = 8000
): Promise<RelayReport[]> {
  if (events.length === 0) return []
  for (const event of events) {
    if (!verifyEvent(event)) throw new Error(`refusing to publish an invalid event ${event.id}`)
  }

  const pool = new SimplePool()
  try {
    return await Promise.all(
      relays.map(async (relay) => {
        try {
          await withTimeout(
            Promise.all(pool.publish([relay], events[0]).map((promise) => promise)),
            timeoutMs
          )
          for (const event of events.slice(1)) {
            await withTimeout(
              Promise.all(pool.publish([relay], event)),
              timeoutMs
            )
          }
          return { relay, ok: true, eventIds: events.map((event) => event.id) }
        } catch (error) {
          return {
            relay,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            eventIds: []
          }
        }
      })
    )
  } finally {
    pool.close(relays)
  }
}
