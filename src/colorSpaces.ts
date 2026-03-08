export type VizSpace = 'rgb' | 'oklab' | 'oklch' | 'hsv' | 'hsl'
export type FrameType = 'cube' | 'cylinder'

export const FRAME_TYPE: Record<VizSpace, FrameType> = {
  rgb:   'cube',
  oklab: 'cube',
  oklch: 'cylinder',
  hsv:   'cylinder',
  hsl:   'cylinder',
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

export function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function oklabFromRgb(r: number, g: number, b: number): [number, number, number] {
  const lr = linearize(r), lg = linearize(g), lb = linearize(b)
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ]
}

function hsvFromRgb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const v = max, s = max === 0 ? 0 : d / max
  let h = 0
  if (d > 0) {
    if (max === r)      h = (((g - b) / d) % 6 + 6) % 6 / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else                h = ((r - g) / d + 4) / 6
  }
  return [h, s, v]
}

function hslFromRgb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2, d = max - min
  let h = 0, s = 0
  if (d > 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === r)      h = (((g - b) / d) % 6 + 6) % 6 / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else                h = ((r - g) / d + 4) / 6
  }
  return [h, s, l]
}

// OKLab a/b practical range ≈ ±0.35; max chroma ≈ 0.35√2
const OKAB_HALF = 0.35
const OKAB_MAX_C = OKAB_HALF * Math.SQRT2

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert an RGB colour to 3D visualisation coordinates.
 *
 * Cube spaces  (RGB, OKLab):  returns [0,1]³ Cartesian.
 * Cylinder spaces (HSV, HSL, OKLCh): returns Cartesian from cylindrical mapping
 *   where radius ∈ [0, 0.5], height ∈ [-0.5, 0.5] so the cylinder is
 *   naturally centred at the origin — no group offset needed.
 */
export function convertVizCoords(
  r: number, g: number, b: number,
  space: VizSpace,
): [number, number, number] {
  switch (space) {
    case 'rgb':
      return [r, g, b]

    case 'oklab': {
      const [L, a, bv] = oklabFromRgb(r, g, b)
      return [L, (a + OKAB_HALF) / (2 * OKAB_HALF), (bv + OKAB_HALF) / (2 * OKAB_HALF)]
    }

    case 'oklch': {
      const [L, a, bv] = oklabFromRgb(r, g, b)
      const C  = Math.sqrt(a * a + bv * bv)
      const θ  = Math.atan2(bv, a)              // already in radians
      const rn = Math.min(C / OKAB_MAX_C, 1) * 0.5
      return [rn * Math.cos(θ), L - 0.5, rn * Math.sin(θ)]
    }

    case 'hsv': {
      const [h, s, v] = hsvFromRgb(r, g, b)
      const θ = h * 2 * Math.PI
      return [s * 0.5 * Math.cos(θ), v - 0.5, s * 0.5 * Math.sin(θ)]
    }

    case 'hsl': {
      const [h, s, l] = hslFromRgb(r, g, b)
      const θ = h * 2 * Math.PI
      return [s * 0.5 * Math.cos(θ), l - 0.5, s * 0.5 * Math.sin(θ)]
    }
  }
}

/** Labels for the three semantic axes of each space [angle-or-x, radius-or-y, height-or-z] */
export const VIZ_AXES: Record<VizSpace, [string, string, string]> = {
  rgb:   ['R', 'G', 'B'],
  oklab: ['L', 'a', 'b'],
  oklch: ['∠H', 'rC', '↕L'],
  hsv:   ['∠H', 'rS', '↕V'],
  hsl:   ['∠H', 'rS', '↕L'],
}

/**
 * Axis line colours.
 * Cube:     [x-axis, y-axis, z-axis]
 * Cylinder: [H/angle, S/C/radius, V/L/height]
 */
export const VIZ_AXIS_COLORS: Record<VizSpace, [string, string, string]> = {
  rgb:   ['#ff4040', '#40ff40', '#4080ff'],
  oklab: ['#e0e0e0', '#ff60a0', '#60c0ff'],
  oklch: ['#a060ff', '#ffc040', '#e0e0e0'],  // H=purple, C=gold, L=white
  hsv:   ['#ff9040', '#ffffff', '#a0c0ff'],  // H=orange, S=white, V=blue
  hsl:   ['#ff9040', '#ffffff', '#606060'],  // H=orange, S=white, L=gray
}
