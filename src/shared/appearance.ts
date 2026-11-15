import { normalizeAppearance, type AppearanceConfig } from './types'

const APPEARANCE_ARG_PREFIX = '--ncc-appearance='

/** Handed to the chrome renderer through `webPreferences.additionalArguments`. */
export function appearanceBootArgument(appearance: AppearanceConfig): string {
  return `${APPEARANCE_ARG_PREFIX}${encodeURIComponent(JSON.stringify(appearance))}`
}

/** Read the boot argument in a preload, before the renderer's first paint. */
export function readAppearanceBootArgument(argv: readonly string[]): AppearanceConfig | null {
  const raw = argv.find((value) => value.startsWith(APPEARANCE_ARG_PREFIX))
  if (!raw) return null
  try {
    return normalizeAppearance(
      JSON.parse(decodeURIComponent(raw.slice(APPEARANCE_ARG_PREFIX.length)))
    )
  } catch {
    return null
  }
}
