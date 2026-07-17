/**
 * Skill Market utility functions — aligned with ComputeNest avatarColor.ts + SkillContent/utils
 */

// Color channel adjustment constants (same as ComputeNest)
const CHANNEL_MIN = 50
const CHANNEL_RANGE = 190
const CHANNEL_MAX = 240
const SATURATION_BOOST = 60
const LOW_SATURATION_THRESHOLD = 80
const SOFT_BG_ALPHA = 0.15
const TEXT_COLOR_ALPHA = 0.9
const DEFAULT_SOFT_COLOR = 'rgba(24, 144, 255, 0.35)'
const DEFAULT_TEXT_COLOR = 'rgba(13, 90, 167, 0.9)'

/**
 * Simple DJB2 hash — replaces CryptoJS.MD5 for avatar color generation.
 * Produces a deterministic hex hash from a string.
 */
function djb2Hex(str: string): string {
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = ((h1 << 5) + h1) ^ ch
    h2 = ((h2 << 5) + h2) ^ ch
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0')
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0')
  return hex1 + hex2
}

/**
 * Generate a soft/transparent background color from a string.
 * Same algorithm as ComputeNest's generateSoftColorFromString but using DJB2 hash.
 */
export function generateSoftColorFromString(str: string): string {
  if (!str) return DEFAULT_SOFT_COLOR

  const hash = djb2Hex(str)

  const r = parseInt(hash.substring(0, 2), 16)
  const g = parseInt(hash.substring(2, 4), 16)
  const b = parseInt(hash.substring(4, 6), 16)

  const adjustedR = Math.floor((r % CHANNEL_RANGE) + CHANNEL_MIN)
  const adjustedG = Math.floor((g % CHANNEL_RANGE) + CHANNEL_MIN)
  const adjustedB = Math.floor((b % CHANNEL_RANGE) + CHANNEL_MIN)

  const max = Math.max(adjustedR, adjustedG, adjustedB)
  const min = Math.min(adjustedR, adjustedG, adjustedB)

  if (max - min < LOW_SATURATION_THRESHOLD) {
    let finalR = adjustedR
    let finalG = adjustedG
    let finalB = adjustedB

    if (adjustedR === max) finalR = Math.min(CHANNEL_MAX, adjustedR + SATURATION_BOOST)
    else if (adjustedG === max) finalG = Math.min(CHANNEL_MAX, adjustedG + SATURATION_BOOST)
    else finalB = Math.min(CHANNEL_MAX, adjustedB + SATURATION_BOOST)

    return `rgba(${finalR}, ${finalG}, ${finalB}, ${SOFT_BG_ALPHA})`
  }

  return `rgba(${adjustedR}, ${adjustedG}, ${adjustedB}, ${SOFT_BG_ALPHA})`
}

/**
 * Generate a darker text color from a background rgba/hex color.
 * Same algorithm as ComputeNest's generateDarkerTextColor.
 */
export function generateDarkerTextColor(bgColor: string): string {
  const rgbaMatch = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)/)
  if (rgbaMatch) {
    const r = parseInt(rgbaMatch[1], 10)
    const g = parseInt(rgbaMatch[2], 10)
    const b = parseInt(rgbaMatch[3], 10)
    return `rgba(${r}, ${g}, ${b}, ${TEXT_COLOR_ALPHA})`
  }

  // Expand #RGB shorthand
  if (/^#[0-9a-fA-F]{3}$/.test(bgColor)) {
    const r = bgColor[1], g = bgColor[2], b = bgColor[3]
    bgColor = `#${r}${r}${g}${g}${b}${b}`
  }

  if (bgColor.length === 7 && bgColor.startsWith('#')) {
    const r = parseInt(bgColor.substring(1, 3), 16)
    const g = parseInt(bgColor.substring(3, 5), 16)
    const b = parseInt(bgColor.substring(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${TEXT_COLOR_ALPHA})`
  }

  return DEFAULT_TEXT_COLOR
}

/**
 * Format an update time string for display.
 */
export function formatUpdateTime(timeStr: string | undefined | null): string {
  if (!timeStr) return ''
  try {
    const date = new Date(timeStr)
    return date.toLocaleDateString()
  } catch {
    return ''
  }
}
