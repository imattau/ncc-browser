import { randomInt } from 'node:crypto'
import type { PasswordGeneratorOptions } from '@shared/passwords'

const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/'
const AMBIGUOUS = /[Il1O0o]/g

const DEFAULT_LENGTH = 20

/** Generate a password with at least one character from every selected class. */
export function generatePassword(options: PasswordGeneratorOptions = {}): string {
  const length = clampLength(options.length)
  const avoidAmbiguous = options.avoidAmbiguous === true
  const clean = (value: string): string =>
    avoidAmbiguous ? value.replace(AMBIGUOUS, '') : value

  const sets: string[] = []
  if (options.lowercase !== false) sets.push(clean('abcdefghijklmnopqrstuvwxyz'))
  if (options.uppercase !== false) sets.push(clean('ABCDEFGHIJKLMNOPQRSTUVWXYZ'))
  if (options.digits !== false) sets.push(clean('0123456789'))
  if (options.symbols === true) sets.push(clean(SYMBOLS))

  const enabled = sets.filter((set) => set.length > 0)
  if (enabled.length === 0) enabled.push(LOWER)
  const pool = enabled.join('')

  const chars: string[] = []
  for (const set of enabled) {
    if (chars.length >= length) break
    chars.push(set[randomInt(set.length)])
  }
  while (chars.length < length) chars.push(pool[randomInt(pool.length)])
  shuffle(chars)
  return chars.join('')
}

function clampLength(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LENGTH
  return Math.max(12, Math.min(64, Math.round(value)))
}

function shuffle(values: string[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1)
    const value = values[index]
    values[index] = values[swap]
    values[swap] = value
  }
}
