export interface Theme {
  accent:    string
  muted:     string
  text:      string
  panel:     string
  border:    string
  bg:        string
  canvas3d:  string
  paletteBg: string
  overlayBg: string
}

export const DARK: Theme = {
  accent:    'rgb(140, 140, 140)',
  muted:     'rgb(110, 110, 110)',
  text:      '#b0b0b0',
  panel:     'rgba(12, 12, 12, 0.9)',
  border:    'rgba(140, 140, 140, 0.2)',
  bg:        '#080808',
  canvas3d:  '#080808',
  paletteBg: '#0d0d0d',
  overlayBg: 'rgba(10,10,10,0.92)',
}

export const LIGHT: Theme = {
  accent:    'rgb(90, 90, 90)',
  muted:     'rgb(120, 120, 120)',
  text:      '#222222',
  panel:     'rgba(255, 255, 255, 0.82)',
  border:    'rgba(110, 110, 110, 0.28)',
  bg:        '#e8e8e8',
  canvas3d:  '#eeeeee',
  paletteBg: '#d8d8d8',
  overlayBg: 'rgba(240,240,240,0.92)',
}

// Static UI colors
export const DANGER       = 'rgb(200,80,80)'
export const DANGER_BG    = 'rgba(200,80,80,0.15)'
export const DRAG_OVERLAY = 'rgba(0,0,0,0.75)'
export const MODAL_SCRIM  = 'rgba(0,0,0,0.6)'

// 3D scene colors
export const CUBE_EDGE_LIGHT = '#c0c0c0'
export const CUBE_EDGE_DARK  = '#1a1a1a'
export const MESH_BG_DARK    = 0x1a1a1a

// ─── Palette-derived theme ────────────────────────────────────────────────────

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function chroma(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function cssHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function cssRgb(r: number, g: number, b: number): string {
  return `rgb(${Math.round(clamp(r)*255)},${Math.round(clamp(g)*255)},${Math.round(clamp(b)*255)})`
}

function cssRgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(clamp(r)*255)},${Math.round(clamp(g)*255)},${Math.round(clamp(b)*255)},${a})`
}

/**
 * Extract the four corner cells from a palette grid into a compact 12-float
 * array [TL, TR, BL, BR] so the theme can be derived in O(1) independently
 * of the full palette copy used by the 3D visualisation.
 */
export function extractPaletteCorners(
  palette: Float32Array,
  rows: number,
  cols: number,
): Float32Array {
  const out = new Float32Array(12)
  const indices = [0, cols - 1, (rows - 1) * cols, rows * cols - 1]
  for (let c = 0; c < 4; c++) {
    const i = indices[c] * 3
    out[c * 3] = palette[i]; out[c * 3 + 1] = palette[i + 1]; out[c * 3 + 2] = palette[i + 2]
  }
  return out
}

/**
 * Derive a theme from a 12-float corner array produced by extractPaletteCorners.
 * Corners are sorted by luminance (value) and chroma to assign roles:
 *   darkest  → bg base in dark mode
 *   lightest → bg base in light mode / text base in dark mode
 *   most chromatic → accent
 * Falls back to DARK/LIGHT before any palette is generated.
 */
export function deriveTheme(
  corners: Float32Array | null,
  lightMode: boolean,
): Theme {
  if (!corners) return lightMode ? LIGHT : DARK

  const cornersRgb: [number, number, number][] = Array.from({ length: 4 }, (_, c) => [
    corners[c * 3], corners[c * 3 + 1], corners[c * 3 + 2],
  ])

  // Sort by luminance and chroma
  const byLuma   = [...cornersRgb].sort((a, b) => luma(...a)   - luma(...b))
  const byChroma = [...cornersRgb].sort((a, b) => chroma(...a) - chroma(...b))

  const [darkR,   darkG,   darkB]   = byLuma[0]
  const [lightR,  lightG,  lightB]  = byLuma[byLuma.length - 1]
  const [accentR, accentG, accentB] = byChroma[byChroma.length - 1]

  if (lightMode) {
    // bg: lightest corner washed toward white
    const bgR = mix(lightR, 1, 0.6), bgG = mix(lightG, 1, 0.6), bgB = mix(lightB, 1, 0.6)

    // accent: most chromatic, darkened for legibility on light bg
    const aL = luma(accentR, accentG, accentB)
    const darken = aL > 0.35 ? 0.5 : aL > 0.15 ? 0.75 : 1.0
    const aR = accentR * darken, aG = accentG * darken, aB = accentB * darken

    const mR = mix(aR, 0.55, 0.5), mG = mix(aG, 0.55, 0.5), mB = mix(aB, 0.55, 0.5)
    const tR = mix(darkR, 0, 0.5),  tG = mix(darkG, 0, 0.5),  tB = mix(darkB, 0, 0.5)

    return {
      accent:    cssRgb(aR, aG, aB),
      muted:     cssRgb(mR, mG, mB),
      text:      cssHex(tR, tG, tB),
      panel:     'rgba(255,255,255,0.82)',
      border:    cssRgba(aR, aG, aB, 0.28),
      bg:        cssHex(bgR, bgG, bgB),
      canvas3d:  cssHex(mix(bgR, 1, 0.3), mix(bgG, 1, 0.3), mix(bgB, 1, 0.3)),
      paletteBg: cssHex(mix(bgR, 0.85, 0.2), mix(bgG, 0.85, 0.2), mix(bgB, 0.85, 0.2)),
      overlayBg: cssRgba(bgR, bgG, bgB, 0.92),
    }
  } else {
    // bg: darkest corner pushed toward black
    const bgR = mix(darkR, 0, 0.75), bgG = mix(darkG, 0, 0.75), bgB = mix(darkB, 0, 0.75)

    // accent: most chromatic, brightened if too dark to read
    const aL = luma(accentR, accentG, accentB)
    const brighten = aL < 0.08 ? 2.5 : aL < 0.2 ? 1.5 : 1.0
    const aR = Math.min(1, accentR * brighten)
    const aG = Math.min(1, accentG * brighten)
    const aB = Math.min(1, accentB * brighten)

    const mR = mix(aR, 0.45, 0.5), mG = mix(aG, 0.45, 0.5), mB = mix(aB, 0.45, 0.5)
    const tR = mix(lightR, 1, 0.25), tG = mix(lightG, 1, 0.25), tB = mix(lightB, 1, 0.25)

    return {
      accent:    cssRgb(aR, aG, aB),
      muted:     cssRgb(mR, mG, mB),
      text:      cssHex(tR, tG, tB),
      panel:     cssRgba(bgR, bgG, bgB, 0.9),
      border:    cssRgba(aR, aG, aB, 0.2),
      bg:        cssHex(bgR, bgG, bgB),
      canvas3d:  cssHex(bgR, bgG, bgB),
      paletteBg: cssHex(mix(bgR, 0.04, 0.4), mix(bgG, 0.04, 0.4), mix(bgB, 0.04, 0.4)),
      overlayBg: cssRgba(bgR, bgG, bgB, 0.92),
    }
  }
}
