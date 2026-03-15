// ─── Edge config ─────────────────────────────────────────────────────────────

export type EdgeCollapse = 'free' | 'collapsed'
export type AxisConnect  = 'free' | 'wrap' | 'twist'

export interface EdgeConfig {
  top:      EdgeCollapse
  bottom:   EdgeCollapse
  left:     EdgeCollapse
  right:    EdgeCollapse
  hConnect: AxisConnect   // left ↔ right
  vConnect: AxisConnect   // top  ↔ bottom
}

export const DEFAULT_CONFIG: EdgeConfig = {
  top: 'free', bottom: 'free',
  left: 'free', right: 'free',
  hConnect: 'free', vConnect: 'free',
}

// ─── Axis state derivation ────────────────────────────────────────────────────
// F  = both free
// FC = one free, one collapsed (only valid when connection is free)
// C  = both collapsed
// W  = wrapped
// T  = twisted
// K  = collapsed + connected (kiss)

type AxisState = 'F' | 'FC' | 'C' | 'W' | 'T' | 'K'

function hAxis(cfg: EdgeConfig): AxisState {
  const { left: l, right: r, hConnect: h } = cfg
  if (h === 'free') {
    if (l === 'free'      && r === 'free')      return 'F'
    if (l === 'collapsed' && r === 'collapsed') return 'C'
    return 'FC'
  }
  if (l === 'collapsed' && r === 'collapsed') return 'K'
  return h === 'wrap' ? 'W' : 'T'
}

function vAxis(cfg: EdgeConfig): AxisState {
  const { top: t, bottom: b, vConnect: v } = cfg
  if (v === 'free') {
    if (t === 'free'      && b === 'free')      return 'F'
    if (t === 'collapsed' && b === 'collapsed') return 'C'
    return 'FC'
  }
  if (t === 'collapsed' && b === 'collapsed') return 'K'
  return v === 'wrap' ? 'W' : 'T'
}

// ─── Topology name lookup ─────────────────────────────────────────────────────

type Tier = 'common' | 'intermediate' | 'exotic'

const TOPOLOGIES: Record<string, { name: string; tier: Tier }> = {
  'F:F':   { name: 'Rectangle',     tier: 'common' },
  'FC:F':  { name: 'Ogive',         tier: 'common' },
  'F:FC':  { name: 'Ogive',         tier: 'common' },
  'C:F':   { name: 'Lens',          tier: 'common' },
  'F:C':   { name: 'Lens',          tier: 'common' },
  'FC:FC': { name: 'Canoe',         tier: 'common' },
  'FC:C':  { name: 'Saucière',      tier: 'common' },
  'C:FC':  { name: 'Saucière',      tier: 'common' },
  'C:C':   { name: 'Teardrop',      tier: 'common' },
  // Wrap
  'W:F':   { name: 'Cylinder',      tier: 'common' },
  'F:W':   { name: 'Cylinder',      tier: 'common' },
  'W:FC':  { name: 'Dome',          tier: 'intermediate' },
  'FC:W':  { name: 'Dome',          tier: 'intermediate' },
  'W:C':   { name: 'Sphere',        tier: 'intermediate' },
  'C:W':   { name: 'Sphere',        tier: 'intermediate' },
  'W:W':   { name: 'Torus',         tier: 'common' },
  'W:K':   { name: 'Horn Torus',    tier: 'intermediate' },
  'K:W':   { name: 'Horn Torus',    tier: 'intermediate' },
  'K:F':   { name: 'Cannoli',       tier: 'intermediate' },
  'F:K':   { name: 'Cannoli',       tier: 'intermediate' },
  'K:K':   { name: 'Teardrop',      tier: 'intermediate' },
  // Twist
  'T:F':   { name: 'Möbius',        tier: 'common' },
  'F:T':   { name: 'Möbius',        tier: 'common' },
  'T:W':   { name: 'Klein',         tier: 'intermediate' },
  'W:T':   { name: 'Klein',         tier: 'intermediate' },
  'T:T':   { name: "Boy's Surface", tier: 'exotic' },
  'T:K':   { name: 'Cross-cap',     tier: 'exotic' },
  'K:T':   { name: 'Cross-cap',     tier: 'exotic' },
  'T:FC':  { name: 'Conch',         tier: 'intermediate' },
  'FC:T':  { name: 'Conch',         tier: 'intermediate' },
  'T:C':   { name: 'Roman Surface', tier: 'exotic' },
  'C:T':   { name: 'Roman Surface', tier: 'exotic' },
  // Aliases (degenerate — reduce to simpler shapes)
  'FC:K':  { name: 'Saucière',      tier: 'common' },
  'K:FC':  { name: 'Saucière',      tier: 'common' },
  'C:K':   { name: 'Teardrop',      tier: 'common' },
  'K:C':   { name: 'Teardrop',      tier: 'common' },
}

export function getTopologyKey(cfg: EdgeConfig): string {
  return `${hAxis(cfg)}:${vAxis(cfg)}`
}

export function getTopology(cfg: EdgeConfig): { name: string; tier: Tier } {
  const key = getTopologyKey(cfg)
  return TOPOLOGIES[key] ?? { name: 'Unknown', tier: 'common' }
}

// ─── Collapsed edge components ────────────────────────────────────────────────
//
// Adjacent collapsed edges share a corner and therefore collapse to the SAME
// pole. We find connected components of collapsed edges (adjacency = sharing a
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

function collapsedPoleFns(cfg: EdgeConfig, rows: number, cols: number): ((r: number, c: number) => number)[] {
  const collapsed: EdgeName[] = []
  if (cfg.top    === 'collapsed') collapsed.push('top')
  if (cfg.bottom === 'collapsed') collapsed.push('bottom')
  if (cfg.left   === 'collapsed') collapsed.push('left')
  if (cfg.right  === 'collapsed') collapsed.push('right')
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
  if (cfg.vConnect !== 'free' && parent.has('top')  && parent.has('bottom')) parent.set(find('top'),  find('bottom'))
  if (cfg.hConnect !== 'free' && parent.has('left') && parent.has('right'))  parent.set(find('left'), find('right'))

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

  if (cfg.hConnect === 'wrap') {
    images.push([r2, c2 - cols], [r2, c2 + cols])
  } else if (cfg.hConnect === 'twist') {
    const fr = rows - 1 - r2
    images.push([fr, c2 - cols], [fr, c2 + cols])
  }

  if (cfg.vConnect !== 'free') {
    const base = images.slice()
    for (const [r, c] of base) {
      if (cfg.vConnect === 'wrap') {
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
  for (const poleDist of collapsedPoleFns(cfg, rows, cols)) {
    minDist = Math.min(minDist, poleDist(r1, c1) + poleDist(r2, c2))
  }

  return minDist
}
