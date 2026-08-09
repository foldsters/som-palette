import { convertVizCoords, FRAME_TYPE, type VizSpace } from '../colorSpaces'

// ─── Layout modes ───────────────────────────────────────────────────────────
// The graph app can lay its nodes out three ways, all sharing one idea: each
// node eases toward a *target position*. 'graph' has no target (force-directed
// physics owns it); the other modes encode meaning in the target.
//   graph      — force-directed springs/repulsion (existing, arbitrary layout)
//   colorspace — node position = its coordinate in a chosen colour space
//   surface    — node snapped to its nearest palletope cell (added later)

export type LayoutMode = 'graph' | 'colorspace'

export interface LayoutConfig {
  mode: LayoutMode
  space: VizSpace
}

export const VIZ_SPACES: VizSpace[] = ['rgb', 'oklab', 'oklch', 'hsv', 'hsl']

// Editor geometry — mirrors EDITOR_SIZE / 2 in App.tsx.
const CENTER = 300
// How wide (px) the normalised colour coordinates spread. Components live in
// [-0.5, 0.5] once centred, so ±0.5·SPAN keeps nodes comfortably inside 600px.
const SPAN = 420

export interface Vec3 { x: number; y: number; z: number }

/**
 * Target position (editor pixel space) for a node given its colour.
 * `r,g,b` are sRGB 0..1 — exactly what the colours array stores.
 * Returns null when the mode carries no positional target (i.e. 'graph'),
 * so callers fall back to the physics simulation.
 */
export function computeTargetPosition(
  r: number, g: number, b: number,
  config: LayoutConfig,
): Vec3 | null {
  if (config.mode === 'colorspace') {
    const [c0, c1, c2] = convertVizCoords(r, g, b, config.space)
    // Cube spaces (RGB, OKLab) return [0,1]³; cylinder spaces (HSV/HSL/OKLCh)
    // are already origin-centred. Normalise both to centred [-0.5, 0.5].
    const cube = FRAME_TYPE[config.space] === 'cube'
    const nx = cube ? c0 - 0.5 : c0
    const ny = cube ? c1 - 0.5 : c1
    const nz = cube ? c2 - 0.5 : c2
    return {
      x: CENTER + nx * SPAN,
      y: CENTER - ny * SPAN,   // screen y grows downward — flip so lightness rises up
      z: nz * SPAN,
    }
  }
  return null
}
