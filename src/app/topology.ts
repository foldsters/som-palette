// ─── Edge config ─────────────────────────────────────────────────────────────

export type EdgePinch   = 'open' | 'pinched'
export type AxisJoin = 'free' | 'wrap' | 'twist'  // 'wrap' and 'twist' are join subtypes — only distinct when both edges are open (unpinched)

export interface EdgeConfig {
  top:      EdgePinch
  bottom:   EdgePinch
  left:     EdgePinch
  right:    EdgePinch
  hJoin: AxisJoin   // left ↔ right
  vJoin: AxisJoin   // top  ↔ bottom
}

export const DEFAULT_CONFIG: EdgeConfig = {
  top: 'open', bottom: 'open',
  left: 'open', right: 'open',
  hJoin: 'free', vJoin: 'free',
}

// ─── Axis state derivation ────────────────────────────────────────────────────
// open         = both edges open
// half-pinched = one open, one pinched (only valid when connection is free)
// pinched      = both edges pinched
// wrapped      = edges identified with same orientation
// twisted      = edges identified with reversed orientation
// pinched-joined = both edges pinched and identified (kiss)

type AxisState = 'open' | 'half-pinched' | 'pinched' | 'wrapped' | 'twisted' | 'pinched-joined'

function hAxis(cfg: EdgeConfig): AxisState {
  const { left: l, right: r, hJoin: h } = cfg
  if (h === 'free') {
    if (l === 'open'    && r === 'open')    return 'open'
    if (l === 'pinched' && r === 'pinched') return 'pinched'
    return 'half-pinched'
  }
  if (l === 'pinched' && r === 'pinched') return 'pinched-joined'
  return h === 'wrap' ? 'wrapped' : 'twisted'
}

function vAxis(cfg: EdgeConfig): AxisState {
  const { top: t, bottom: b, vJoin: v } = cfg
  if (v === 'free') {
    if (t === 'open'    && b === 'open')    return 'open'
    if (t === 'pinched' && b === 'pinched') return 'pinched'
    return 'half-pinched'
  }
  if (t === 'pinched' && b === 'pinched') return 'pinched-joined'
  return v === 'wrap' ? 'wrapped' : 'twisted'
}

// ─── Topology name lookup ─────────────────────────────────────────────────────

type Tier = 'common' | 'intermediate' | 'exotic'

const TOPOLOGIES: Record<string, { name: string; tier: Tier }> = {
  'open:open':                 { name: 'Rectangle',     tier: 'common' },
  'half-pinched:open':         { name: 'Ogive',         tier: 'common' },
  'open:half-pinched':         { name: 'Ogive',         tier: 'common' },
  'pinched:open':              { name: 'Lens',          tier: 'common' },
  'open:pinched':              { name: 'Lens',          tier: 'common' },
  'half-pinched:half-pinched': { name: 'Canoe',         tier: 'common' },
  'half-pinched:pinched':      { name: 'Saucière',      tier: 'common' },
  'pinched:half-pinched':      { name: 'Saucière',      tier: 'common' },
  'pinched:pinched':           { name: 'Quadrupole', tier: 'common' },
  // Wrap
  'wrapped:open':              { name: 'Cylinder',      tier: 'common' },
  'open:wrapped':              { name: 'Cylinder',      tier: 'common' },
  'wrapped:half-pinched':      { name: 'Dome',          tier: 'intermediate' },
  'half-pinched:wrapped':      { name: 'Dome',          tier: 'intermediate' },
  'wrapped:pinched':           { name: 'Sphere',        tier: 'intermediate' },
  'pinched:wrapped':           { name: 'Sphere',        tier: 'intermediate' },
  'wrapped:wrapped':           { name: 'Torus',         tier: 'common' },
  'wrapped:pinched-joined':    { name: 'Horn Torus',    tier: 'intermediate' },
  'pinched-joined:wrapped':    { name: 'Horn Torus',    tier: 'intermediate' },
  'pinched-joined:open':       { name: 'Cannoli',       tier: 'intermediate' },
  'open:pinched-joined':       { name: 'Cannoli',       tier: 'intermediate' },
  'pinched-joined:pinched-joined': { name: 'Quadrupole', tier: 'intermediate' },
  // Twist
  'twisted:open':              { name: 'Möbius',        tier: 'common' },
  'open:twisted':              { name: 'Möbius',        tier: 'common' },
  'twisted:wrapped':           { name: 'Klein',         tier: 'intermediate' },
  'wrapped:twisted':           { name: 'Klein',         tier: 'intermediate' },
  'twisted:twisted':           { name: "Boy's Surface", tier: 'exotic' },
  'twisted:pinched-joined':    { name: 'Cross-cap',     tier: 'exotic' },
  'pinched-joined:twisted':    { name: 'Cross-cap',     tier: 'exotic' },
  'twisted:half-pinched':      { name: 'Nautilus',      tier: 'intermediate' },
  'half-pinched:twisted':      { name: 'Nautilus',      tier: 'intermediate' },
  // Aliases (degenerate — reduce to simpler shapes)
  'half-pinched:pinched-joined': { name: 'Saucière',    tier: 'common' },
  'pinched-joined:half-pinched': { name: 'Saucière',    tier: 'common' },
  'pinched:pinched-joined':    { name: 'Quadrupole', tier: 'common' },
  'pinched-joined:pinched':    { name: 'Quadrupole', tier: 'common' },
}

export function getTopologyKey(cfg: EdgeConfig): string {
  return `${hAxis(cfg)}:${vAxis(cfg)}`
}

export function getTopology(cfg: EdgeConfig): { name: string; tier: Tier } {
  const key = getTopologyKey(cfg)
  return TOPOLOGIES[key] ?? { name: 'Unknown', tier: 'common' }
}

// ─── Pinched edge components ──────────────────────────────────────────────────
//
// Adjacent pinched edges share a corner and therefore collapse to the SAME
// pole. We find connected components of pinched edges (adjacency = sharing a
// corner: top↔left, top↔right, bottom↔left, bottom↔right) and treat each
// component as a single pole.
//
// The distance from a node (r,c) to a pole is the minimum perpendicular
// distance to any edge in the component.

type EdgeName = 'top' | 'bottom' | 'left' | 'right'

function edgeDist(e: EdgeName, r: number, c: number, rows: number, cols: number): number {
  if (e === 'top')    return r
  if (e === 'bottom') return rows - 1 - r
  if (e === 'left')   return c
  return cols - 1 - c   // right
}

const EDGE_ADJACENT: [EdgeName, EdgeName][] = [
  ['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right'],
]

function pinchedPoleFns(cfg: EdgeConfig, rows: number, cols: number): ((r: number, c: number) => number)[] {
  const collapsed: EdgeName[] = []
  if (cfg.top    === 'pinched') collapsed.push('top')
  if (cfg.bottom === 'pinched') collapsed.push('bottom')
  if (cfg.left   === 'pinched') collapsed.push('left')
  if (cfg.right  === 'pinched') collapsed.push('right')
  if (collapsed.length === 0) return []

  // Union-Find
  const parent = new Map<EdgeName, EdgeName>(collapsed.map(e => [e, e]))
  const find = (x: EdgeName): EdgeName => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
    return parent.get(x)!
  }
  // Corner adjacency
  for (const [a, b] of EDGE_ADJACENT) {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b))
  }
  // Wrap/twist identifies opposite edges — their collapsed poles must be the same point
  if (cfg.vJoin !== 'free' && parent.has('top')  && parent.has('bottom')) parent.set(find('top'),  find('bottom'))
  if (cfg.hJoin !== 'free' && parent.has('left') && parent.has('right'))  parent.set(find('left'), find('right'))

  // Group by root
  const groups = new Map<EdgeName, EdgeName[]>()
  for (const e of collapsed) {
    const root = find(e)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(e)
  }

  return Array.from(groups.values()).map(
    group => (r: number, c: number) => Math.min(...group.map(e => edgeDist(e, r, c, rows, cols)))
  )
}

// ─── Generalized grid distance ────────────────────────────────────────────────
//
// For each pair (r1,c1) and (r2,c2):
//   1. Generate equivalent image positions of (r2,c2) via wrap/twist identifications
//   2. Compute minimum Euclidean distance to any image (in grid units)
//   3. For each connected component of collapsed edges, add a through-pole
//      candidate: poleDist(r1,c1) + poleDist(r2,c2)

export function gridDistance(
  r1: number, c1: number,
  r2: number, c2: number,
  rows: number, cols: number,
  cfg: EdgeConfig,
): number {
  // --- Image positions from wrap/twist identifications ---
  const images: [number, number][] = [[r2, c2]]

  // Only generate image positions for identified-open axes (wrap/twist).
  // Pinched+identified (K) axes are handled entirely by the through-pole path below.
  const hPinched = cfg.left === 'pinched' && cfg.right === 'pinched'
  const vPinched = cfg.top  === 'pinched' && cfg.bottom === 'pinched'

  if (!hPinched && cfg.hJoin === 'wrap') {
    images.push([r2, c2 - cols], [r2, c2 + cols])
  } else if (!hPinched && cfg.hJoin === 'twist') {
    const fr = rows - 1 - r2
    images.push([fr, c2 - cols], [fr, c2 + cols])
  }

  if (!vPinched && cfg.vJoin !== 'free') {
    const base = images.slice()
    for (const [r, c] of base) {
      if (cfg.vJoin === 'wrap') {
        images.push([r - rows, c], [r + rows, c])
      } else { // twist
        const fc = cols - 1 - c
        images.push([r - rows, fc], [r + rows, fc])
      }
    }
  }

  let minDist2 = Infinity
  for (const [r, c] of images) {
    const dr = r1 - r, dc = c1 - c
    minDist2 = Math.min(minDist2, dr * dr + dc * dc)
  }
  let minDist = Math.sqrt(minDist2)

  // --- Through-pole candidates (one per connected component of collapsed edges) ---
  for (const poleDist of pinchedPoleFns(cfg, rows, cols)) {
    minDist = Math.min(minDist, poleDist(r1, c1) + poleDist(r2, c2))
  }

  return minDist
}
