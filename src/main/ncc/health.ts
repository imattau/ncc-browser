/**
 * Endpoint cooldowns. NCC-05 §7 says failed endpoints should not be retried in a
 * tight loop; this tracks consecutive failures per endpoint with exponential backoff.
 */

export interface HealthEntry {
  failures: number
  /** Epoch milliseconds before which the endpoint should be skipped. */
  until: number
}

export class EndpointHealth {
  private readonly entries = new Map<string, HealthEntry>()

  constructor(
    private readonly baseDelayMs = 15_000,
    private readonly maxDelayMs = 300_000
  ) {}

  isCoolingDown(url: string, now = Date.now()): boolean {
    const entry = this.entries.get(url)
    return Boolean(entry && entry.until > now)
  }

  /** Record a failure and return the cooldown that was applied, in milliseconds. */
  recordFailure(url: string, now = Date.now()): number {
    const previous = this.entries.get(url)
    const failures = (previous?.failures ?? 0) + 1
    const delay = Math.min(this.baseDelayMs * 2 ** (failures - 1), this.maxDelayMs)
    this.entries.set(url, { failures, until: now + delay })
    return delay
  }

  recordSuccess(url: string): void {
    this.entries.delete(url)
  }

  get(url: string): HealthEntry | undefined {
    return this.entries.get(url)
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Prefer endpoints that are not cooling down. If every endpoint is cooling down we
 * still try them, otherwise a single-endpoint locator would be unusable until the
 * backoff elapsed.
 */
export function orderByHealth<T extends { url: string }>(
  endpoints: T[],
  health: EndpointHealth,
  now = Date.now()
): T[] {
  const ready = endpoints.filter((endpoint) => !health.isCoolingDown(endpoint.url, now))
  return ready.length > 0 ? ready : endpoints
}
