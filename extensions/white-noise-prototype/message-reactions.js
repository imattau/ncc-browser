const REACTION_LABELS = new Map([
  ['❤️', 'heart'], ['👍', 'thumbs up'], ['😂', 'laugh'],
  ['😮', 'surprised'], ['😢', 'sad'], ['🎉', 'celebrate']
])

export const QUICK_REACTIONS = [...REACTION_LABELS.keys()]

export function reactionContent(content) {
  if (content === '' || content === '+') return '👍'
  if (content === '-') return '👎'
  return content
}

export function summarizeReactions(history, targetId, currentPubkey) {
  const byEmoji = new Map()
  for (const rumor of history) {
    if (rumor.kind !== 7 || !rumor.tags?.some(tag => tag[0] === 'e' && tag[1] === targetId)) continue
    const emoji = reactionContent(rumor.content)
    if (!emoji) continue
    let summary = byEmoji.get(emoji)
    if (!summary) {
      summary = { emoji, authors: new Set(), reacted: false }
      byEmoji.set(emoji, summary)
    }
    summary.authors.add(rumor.pubkey)
    if (rumor.pubkey === currentPubkey) summary.reacted = true
  }
  return [...byEmoji.values()]
    .map(({ emoji, authors, reacted }) => ({ emoji, count: authors.size, reacted }))
    .sort((left, right) => left.emoji.localeCompare(right.emoji))
}

export function reactionLabel(emoji) {
  return REACTION_LABELS.get(emoji) || emoji
}

export function createReactionRumor({ pubkey, target, emoji, createdAt = Math.floor(Date.now() / 1000) }) {
  if (!/^[0-9a-f]{64}$/i.test(target?.id || '') || !/^[0-9a-f]{64}$/i.test(target?.pubkey || '')) {
    throw new Error('This message cannot be reacted to because its reference is invalid.')
  }
  if (typeof emoji !== 'string' || !emoji.trim() || emoji.length > 64) throw new Error('Choose a reaction.')
  return {
    id: '',
    pubkey,
    created_at: createdAt,
    kind: 7,
    content: emoji,
    tags: [['e', target.id, '', target.pubkey], ['p', target.pubkey], ['k', String(target.kind)]]
  }
}
