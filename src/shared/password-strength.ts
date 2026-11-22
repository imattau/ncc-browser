/**
 * Pure, local password-strength estimate. No network calls, no dictionaries
 * beyond a small built-in common-password list, safe to run in the renderer.
 */

export type PasswordStrengthScore = 0 | 1 | 2 | 3 | 4

export interface PasswordStrength {
  score: PasswordStrengthScore
  label: 'Very weak' | 'Weak' | 'Fair' | 'Strong' | 'Very strong'
  /** Rough log2(guesses) estimate after discounting repeats/sequences. */
  entropyBits: number
  warning: string | null
}

const LABELS: PasswordStrength['label'][] = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong']

/** A short list of extremely common passwords; presence here caps the score at 0. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', '123456', '123456789', 'qwerty', 'qwerty123',
  '111111', '12345678', 'abc123', '1234567', 'letmein', 'monkey',
  'iloveyou', 'admin', 'welcome', 'login', 'passw0rd', '1q2w3e4r',
  'football', 'dragon'
])

const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

export function scorePassword(password: string): PasswordStrength {
  if (!password) {
    return { score: 0, label: 'Very weak', entropyBits: 0, warning: 'Enter a password' }
  }

  const lower = password.toLowerCase()
  if (COMMON_PASSWORDS.has(lower)) {
    return { score: 0, label: 'Very weak', entropyBits: 0, warning: 'This is a commonly used password' }
  }

  const poolSize = classPoolSize(password)
  const effectiveLength = discountedLength(password)
  const entropyBits = effectiveLength * Math.log2(Math.max(poolSize, 2))

  let score: PasswordStrengthScore
  if (entropyBits < 28) score = 0
  else if (entropyBits < 36) score = 1
  else if (entropyBits < 60) score = 2
  else if (entropyBits < 80) score = 3
  else score = 4

  if (password.length < 8 && score > 1) score = 1

  let warning: string | null = null
  if (score <= 1) {
    warning = password.length < 12 ? 'Use a longer password' : 'Mix in more character types or avoid repeated patterns'
  }

  return { score, label: LABELS[score], entropyBits: Math.round(entropyBits), warning }
}

function classPoolSize(password: string): number {
  let pool = 0
  if (/[a-z]/.test(password)) pool += 26
  if (/[A-Z]/.test(password)) pool += 26
  if (/[0-9]/.test(password)) pool += 10
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33
  return pool
}

/** Shrinks the counted length to discount repeated characters and simple runs. */
function discountedLength(password: string): number {
  const lower = password.toLowerCase()
  let discounted = 0
  let index = 0
  while (index < password.length) {
    const runLength = repeatedRunLength(password, index)
    if (runLength >= 3) {
      discounted += 1 + Math.log2(runLength)
      index += runLength
      continue
    }
    const sequenceLength = sequenceRunLength(lower, index)
    if (sequenceLength >= 3) {
      discounted += 1 + Math.log2(sequenceLength)
      index += sequenceLength
      continue
    }
    discounted += 1
    index += 1
  }
  return discounted
}

function repeatedRunLength(value: string, start: number): number {
  const char = value[start]
  let end = start + 1
  while (end < value.length && value[end] === char) end += 1
  return end - start
}

function sequenceRunLength(lower: string, start: number): number {
  for (const sequence of SEQUENCES) {
    const forward = longestMatch(lower, start, sequence)
    if (forward >= 3) return forward
    const backward = longestMatch(lower, start, [...sequence].reverse().join(''))
    if (backward >= 3) return backward
  }
  return 0
}

function longestMatch(lower: string, start: number, sequence: string): number {
  for (let offset = 0; offset <= sequence.length - 3; offset += 1) {
    let length = 0
    while (
      start + length < lower.length &&
      offset + length < sequence.length &&
      lower[start + length] === sequence[offset + length]
    ) {
      length += 1
    }
    if (length >= 3) return length
  }
  return 0
}
