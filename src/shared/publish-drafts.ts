/** Unfinished publishing forms, kept so a crash or restart does not lose them. */
export type PublishDraftKind = 'service' | 'site'

export const PUBLISH_DRAFT_KINDS: readonly PublishDraftKind[] = ['service', 'site']

/** Far more than a form holds; stops the file being used for anything else. */
export const MAX_PUBLISH_DRAFT_BYTES = 64 * 1024
