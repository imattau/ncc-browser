import { useSyncExternalStore } from 'react'

/**
 * State that outlives the screen showing it. Publishing carries on when the user
 * leaves a settings section, so its progress and Cancel button must still be there
 * when they come back.
 */
export interface JobStore<T> {
  get: () => T
  set: (next: T | ((current: T) => T)) => void
  use: () => T
  subscribe: (listener: () => void) => () => void
}

export function createJobStore<T>(initial: T): JobStore<T> {
  let value = initial
  const listeners = new Set<() => void>()
  const get = (): T => value
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    get,
    subscribe,
    set: (next) => {
      value = typeof next === 'function' ? (next as (current: T) => T)(value) : next
      for (const listener of listeners) listener()
    },
    use: () => useSyncExternalStore(subscribe, get)
  }
}
