import { describe, expect, it } from 'vitest'
import { shouldRetryWithActiveService } from '../src/main/ncc/routing'

describe('shouldRetryWithActiveService', () => {
  it('retries a subresource whose guessed service does not match the tab\'s actual active service', () => {
    // The exact bug this guards: an absolute-path subresource like
    // "/assets/app.js" gets routed by guessing "assets" as the service
    // name when neither Referer nor the active-service map had an answer
    // yet -- a guess that is always wrong once the real active service
    // becomes known.
    expect(shouldRetryWithActiveService(false, null, 'assets', 'search')).toBe(true)
  })

  it('never retries a document request -- a document names its own service in the URL', () => {
    expect(shouldRetryWithActiveService(true, null, 'assets', 'search')).toBe(false)
  })

  it('never overrides an explicit referer-named service, even if resolution failed', () => {
    // routeNccPath itself trusts an explicit cross-service referer over the
    // active-service map; the retry must not second-guess that choice.
    expect(shouldRetryWithActiveService(false, 'npanel', 'npanel', 'search')).toBe(false)
  })

  it('does not retry when there is no known active service to retry with', () => {
    expect(shouldRetryWithActiveService(false, null, 'assets', null)).toBe(false)
  })

  it('does not retry when the active service is the same one that already failed', () => {
    expect(shouldRetryWithActiveService(false, null, 'search', 'search')).toBe(false)
  })
})
