import { convertVizCoords, FRAME_TYPE, VIZ_AXIS_COLORS, type FrameType, type VizSpace } from '../colorSpaces'

// ─── Layout modes ───────────────────────────────────────────────────────────
// The graph app can lay its nodes out several ways, all sharing one idea: each
// node eases toward a *target position*. 'graph' has no target (force-directed
// physics owns it); the other modes encode meaning in the target.
//   graph      — force-directed springs/repulsion (existing, arbitrary layout)
//   colorspace — node position = its coordinate in a chosen colour space
//   surface    — node snapped to its nearest cell in a 2D palletope SOM render

export type LayoutMode = 'graph' | 'colorspace' | 'surface'

export interface LayoutConfig {
  mode: LayoutMode
  space: VizSpace
  // Present only in 'surface' mode: the trained SOM grid to snap nodes onto.
  // `palette` is RGB triplets in row-major (row*cols+col)*3 order, 0..1.
  surface?: { palette: Float32Array; cols: number; rows: number }
}

export const VIZ_SPACES: VizSpace[] = ['rgb', 'oklab', 'oklch', 'hsv', 'hsl']

// Editor geometry — mirrors EDITOR_SIZE / 2 in App.tsx. Exported so the editors
// can place the colour-space axis frame exactly where the targets land.
export const CENTER = 300
// How wide (px) the normalised colour coordinates spread. Components live in
// [-0.5, 0.5] once centred, so ±0.5·SPAN keeps nodes comfortably inside 600px.
export const SPAN = 420

export interface Vec3 { x: number; y: number; z: number }

/**
 * Target position (editor pixel space) for a node given its colour.
 * `r,g,b` are sRGB 0..1 — exactly what the colours array stores.
 * Returns null when the mode carries no positional target (i.e. 'graph', or
 * 'surface' before its SOM render exists), so callers fall back to physics.
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

  if (config.mode === 'surface') {
    const s = config.surface
    if (!s) return null
    const { palette, cols, rows } = s
    // Best-matching unit: nearest cell in plain RGB (mirrors the SOM's own BMU).
    let minD = Infinity, best = 0
    const count = cols * rows
    for (let i = 0; i < count; i++) {
      const dr = palette[i * 3] - r
      const dg = palette[i * 3 + 1] - g
      const db = palette[i * 3 + 2] - b
      const d = dr * dr + dg * dg + db * db
      if (d < minD) { minD = d; best = i }
    }
    const col = best % cols
    const row = Math.floor(best / cols)
    const size = CENTER * 2  // backdrop fills the full 600px editor
    return { x: (col + 0.5) / cols * size, y: (row + 0.5) / rows * size, z: 0 }
  }

  return null
}

// ─── Colour-space axis frame ─────────────────────────────────────────────────
// Reference geometry mirroring the root viewer's ColorCube frames, expressed in
// *centred normalised* coords ([-0.5, 0.5] per axis). Each editor maps these to
// its own space: 3D via `frameToWorld`, 2D by dropping z.

export interface FrameSegment { a: Vec3; b: Vec3; color: string; width: number }

const EDGE_COLOR = '#555'
const MID_COLOR = '#777'

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

function cubeSegments(space: VizSpace): FrameSegment[] {
  const s = 0.5
  const c: Vec3[] = [
    v(-s, -s, -s), v(s, -s, -s), v(s, s, -s), v(-s, s, -s),
    v(-s, -s, s), v(s, -s, s), v(s, s, s), v(-s, s, s),
  ]
  const E = (i: number, j: number): FrameSegment => ({ a: c[i], b: c[j], color: EDGE_COLOR, width: 1 })
  const segs: FrameSegment[] = [
    E(0, 1), E(1, 2), E(2, 3), E(3, 0),
    E(4, 5), E(5, 6), E(6, 7), E(7, 4),
    E(0, 4), E(1, 5), E(2, 6), E(3, 7),
  ]
  const [cx, cy, cz] = VIZ_AXIS_COLORS[space]
  const o = v(-s, -s, -s)
  segs.push({ a: o, b: v(0.62, -s, -s), color: cx, width: 2 })
  segs.push({ a: o, b: v(-s, 0.62, -s), color: cy, width: 2 })
  segs.push({ a: o, b: v(-s, -s, 0.62), color: cz, width: 2 })
  return segs
}

function cylinderSegments(space: VizSpace): FrameSegment[] {
  const N = 48, r = 0.5
  const ring = (y: number): Vec3[] =>
    Array.from({ length: N + 1 }, (_, i) => {
      const t = (i / N) * 2 * Math.PI
      return v(r * Math.cos(t), y, r * Math.sin(t))
    })
  const ringSegs = (pts: Vec3[], color: string, width: number): FrameSegment[] => {
    const out: FrameSegment[] = []
    for (let i = 0; i < pts.length - 1; i++) out.push({ a: pts[i], b: pts[i + 1], color, width })
    return out
  }
  const segs: FrameSegment[] = []
  segs.push(...ringSegs(ring(-0.5), EDGE_COLOR, 1))
  segs.push(...ringSegs(ring(0.5), EDGE_COLOR, 1))
  segs.push(...ringSegs(ring(0), MID_COLOR, 2))
  const NS = 8
  for (let i = 0; i < NS; i++) {
    const t = (i / NS) * 2 * Math.PI
    const x = r * Math.cos(t), z = r * Math.sin(t)
    segs.push({ a: v(x, -0.5, z), b: v(x, 0.5, z), color: EDGE_COLOR, width: 1 })
  }
  const [, , lColor] = VIZ_AXIS_COLORS[space]
  segs.push({ a: v(0, -0.5, 0), b: v(0, 0.65, 0), color: lColor, width: 2 })
  return segs
}

/** Axis-frame segments (centred normalised coords) for a colour space. */
export function computeFrameSegments(space: VizSpace): { type: FrameType; segments: FrameSegment[] } {
  const type = FRAME_TYPE[space]
  return { type, segments: type === 'cylinder' ? cylinderSegments(space) : cubeSegments(space) }
}

/** Map a centred-normalised frame coord into editor world space (same as targets). */
export function frameToWorld(n: Vec3): Vec3 {
  return { x: CENTER + n.x * SPAN, y: CENTER - n.y * SPAN, z: n.z * SPAN }
}
