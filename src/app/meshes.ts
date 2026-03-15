import * as THREE from 'three'
import type { EdgeConfig } from './topology'

// ─── Generic parametric builder ───────────────────────────────────────────────

function buildParametric(
  fn: (u: number, v: number) => [number, number, number],
  nu: number, nv: number,
  uvFn?: (i: number, j: number, nu: number, nv: number) => [number, number],
): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nv; j++) {
      const u = i / nu, v = j / nv
      const [x, y, z] = fn(u, v)
      positions.push(x, y, z)
      const [tu, tv] = uvFn ? uvFn(i, j, nu, nv) : [u, v]
      uvs.push(tu, tv)
    }
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j
      indices.push(a, a + nv + 1, a + 1, a + 1, a + nv + 1, a + nv + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

// ─── Topology mesh builders ────────────────────────────────────────────────────
// All shapes scaled to fit roughly in a ±0.5 box.

// Rectangle — flat plane
export function makeRectangle(): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(0.9, 0.9, 64, 64)
}

// Ogive V — F:FC — flat wedge; which edge is collapsed determines apex position.
// flipY=true means UV v=1 → palette row 0 (top), UV v=0 → palette last row (bottom).
// Curve formula for apex-at-v=1: w = 0.9*(1−v²)  → f'(0)=0 (⊥ base), 90° at apex
// Curve formula for apex-at-v=0: w = 0.9*(2v−v²) → f'(1)=0 (⊥ base), 90° at apex
export function makeOgiveV(cfg: EdgeConfig): THREE.BufferGeometry {
  if (cfg.top === 'collapsed') {
    // apex at top: UV v=1 = palette row 0 (top, collapsed)
    return buildParametric((u, v) => {
      const w = 0.9 * (1 - v * v)
      return [(u - 0.5) * w, (v - 0.5) * 0.9, 0]
    }, 64, 64)
  } else {
    // apex at bottom: UV v=0 = palette last row (bottom, collapsed)
    return buildParametric((u, v) => {
      const w = 0.9 * (2 * v - v * v)
      return [(u - 0.5) * w, (v - 0.5) * 0.9, 0]
    }, 64, 64)
  }
}

// Ogive H — FC:F — flat wedge; which edge is collapsed determines apex position.
// u is not affected by flipY: UV u=0 → palette left col, UV u=1 → palette right col.
// Curve formula for apex-at-u=1: h = 0.9*(1−u²)  → h'(0)=0 (⊥ base), 90° at apex
// Curve formula for apex-at-u=0: h = 0.9*(2u−u²) → h'(1)=0 (⊥ base), 90° at apex
export function makeOgiveH(cfg: EdgeConfig): THREE.BufferGeometry {
  if (cfg.right === 'collapsed') {
    // apex at right: UV u=1 = palette right column (collapsed)
    return buildParametric((u, v) => {
      const h = 0.9 * (1 - u * u)
      return [(u - 0.5) * 0.9, (v - 0.5) * h, 0]
    }, 64, 64)
  } else {
    // apex at left: UV u=0 = palette left column (collapsed)
    return buildParametric((u, v) => {
      const h = 0.9 * (2 * u - u * u)
      return [(u - 0.5) * 0.9, (v - 0.5) * h, 0]
    }, 64, 64)
  }
}

// Lens H — C:F — flat lens, poles at left (u=0) and right (u=1)
// h = (0.9/π)·sin(πu) gives exactly 90° between the two arcs at each pole.
export function makeLensH(): THREE.BufferGeometry {
  const H = 0.9 / Math.PI
  return buildParametric((u, v) => {
    const h = H * Math.sin(Math.PI * u)
    return [(u - 0.5) * 0.9, (v - 0.5) * 2 * h, 0]
  }, 64, 32)
}

// Lens V — F:C — flat lens, poles at bottom (v=0, palette bottom via flipY) and top (v=1)
export function makeLensV(): THREE.BufferGeometry {
  const H = 0.9 / Math.PI
  return buildParametric((u, v) => {
    const w = H * Math.sin(Math.PI * v)
    return [(u - 0.5) * 2 * w, (v - 0.5) * 0.9, 0]
  }, 32, 64)
}

// Canoe — FC:FC — half-lemon surface: lens-shaped free edges in z=0, surface arches over in z.
// The collapsed corner is determined by cfg: right/left (u=1/u=0) and bottom/top (v=0/v=1).
// pu = u if right collapsed, 1−u if left collapsed (so pu=1 always lands on the collapsed edge).
// pv = v if bottom collapsed, 1−v if top collapsed (so pv=0 always lands on the collapsed edge).
// t = √((1−pu)·pv)  maps 0→pole and 1→free corner.
// φ = 2·atan2(pu,1−pv)  maps 0→u-free arc and π→v-free arc.
// W = L/π gives exactly 90° at the pole.
export function makeCanoe(cfg: EdgeConfig): THREE.BufferGeometry {
  const L = 0.9
  const W = L / Math.PI          // 90° condition: Wπ = L
  const s = 1 / Math.sqrt(2)
  const flipU = cfg.left === 'collapsed'   // pu = 1−u so left edge (u=0) → pu=1 → pole
  const flipV = cfg.top  === 'collapsed'   // pv = 1−v so top  edge (v=1) → pv=0 → pole
  return buildParametric((u, v) => {
    const pu  = flipU ? 1 - u : u
    const pv  = flipV ? 1 - v : v
    const t   = Math.sqrt((1 - pu) * pv)         // lemon-axis param: 0=pole, 1=free corner
    const phi = 2 * Math.atan2(pu, 1 - pv)       // arc angle: 0=pu-free edge, π=pv-free edge
    const xi  = (t - 0.5) * L
    const rho = W * Math.sin(Math.PI * t)
    return [
      (xi + rho * Math.cos(phi)) * s,
      (xi - rho * Math.cos(phi)) * s,
       rho * Math.sin(phi),
    ]
  }, 64, 32)
}

// Saucière — FC:C or C:FC: half-teardrop surface of revolution (180°).
// The free edge lies in the cut plane as a 2D teardrop profile; three collapsed edges
// all meet at the ogive tip (pole). The surface sweeps 180° around the teardrop axis.
// u = axial param (0=hemisphere pole, 1=ogive tip); same profile as makeTeardrop.
// For C:FC (both u-edges collapsed): v·π is the revolution angle, free edge at v=0 or v=1.
// For FC:C (both v-edges collapsed): u·π is the revolution angle, free edge at u=0 or u=1.
function tearProfile(u: number): [number, number] {
  const R     = 0.28
  const L     = R / Math.tan(27.5 * Math.PI / 180)
  const rho   = (R * R + L * L) / (2 * R)
  const cr    = (R * R - L * L) / (2 * R)
  const a_tip = Math.atan2(L, -cr)
  const y_off = (R - L) / 2
  if (u <= 0.5) {
    const s = u * 2
    return [R * Math.sin(s * Math.PI / 2), -R * Math.cos(s * Math.PI / 2) + y_off]
  } else {
    const a = a_tip * (u - 0.5) * 2
    return [cr + rho * Math.cos(a), rho * Math.sin(a) + y_off]
  }
}

export function makeSauciere(cfg: EdgeConfig): THREE.BufferGeometry {
  // Palette mapping (free edge at bottom):
  //   B = (0.5, 0) maps to the dome pole (axis of revolution, v_axial=0)
  //   theta = atan2(x - 0.5, y)  →  revolution angle
  //   u_rev = (theta + π/2) / π  →  u=0: bottom-left, u=0.5: top, u=1: bottom-right
  //   v_axial = dist(B,P) / dist(B, palette edge in direction theta)  →  0=dome pole, 1=ogive tip
  //
  // Inverse (grid u,v → 3D):
  //   theta = u·π - π/2
  //   ray direction from B: (sin(theta), cos(theta))
  //   d_max = distance from B to palette edge in that direction
  //   t = v · d_max  (distance from B)
  //   palette point: x = 0.5 + t·sin(theta), y = t·cos(theta)
  //   feed t (normalized to [0,1] along teardrop axis) into tearProfile

  const freeEdge =
    cfg.bottom === 'free' ? 'bottom' :
    cfg.top    === 'free' ? 'top' :
    cfg.left   === 'free' ? 'left' : 'right'

  return buildParametric((u, v) => {
    // Remap (u,v) so the free edge always feeds the formula as the bottom (pu=u, pv=0)
    let pu = u, pv = v
    if (freeEdge === 'top')   { pu = u;     pv = 1 - v }
    if (freeEdge === 'left')  { pu = v;     pv = u     }
    if (freeEdge === 'right') { pu = 1 - v; pv = 1 - u }

    // Compress palette into semicircle centered at bottom-middle (pu=0.5, pv=0)
    const maxY = 0.5 * Math.sqrt(Math.max(0, 1 - (2*pu - 1) ** 2))
    const su = pu
    const sv = pv * maxY

    const rev  = Math.atan2(su - 0.5, sv) + Math.PI / 2
    const dist = Math.min(1, Math.sqrt((su - 0.5) ** 2 + sv ** 2) * 2)
    const [r, axial] = tearProfile(dist)

    return [r * Math.cos(rev), axial, r * Math.sin(rev)]
  }, 64, 64)
}

// Teardrop — solid of revolution.
// u = pole-to-tip axis (UV u=0 → hemisphere pole, UV u=1 → ogive tip).
// v = wraps around the equator (UV v=0=1, seam stays at the wrap boundary).
// This keeps collapsed outer color only at the tip and the seam invisible.
export function makeTeardrop(): THREE.BufferGeometry {
  const R     = 0.28
  const L     = R / Math.tan(27.5 * Math.PI / 180)  // ~55° half-angle → ~110° full tip
  const rho   = (R * R + L * L) / (2 * R)
  const cr    = (R * R - L * L) / (2 * R)
  const a_tip = Math.atan2(L, -cr)
  const y_off = (R - L) / 2

  return buildParametric((u, v) => {
    const theta = v * 2 * Math.PI  // v wraps around
    let r: number, y: number

    if (u <= 0.5) {
      // Hemisphere: u=0 (pole) → u=0.5 (equator)
      const s = u * 2
      r = R * Math.sin(s * Math.PI / 2)
      y = -R * Math.cos(s * Math.PI / 2) + y_off
    } else {
      // Tangent ogive: u=0.5 (equator) → u=1 (tip)
      const a = a_tip * (u - 0.5) * 2
      r = cr + rho * Math.cos(a)
      y = rho * Math.sin(a) + y_off
    }

    return [r * Math.cos(theta), y, r * Math.sin(theta)]
  }, 64, 64, (i, j, nu, nv) => {
    // Hybrid UV: circular for most of the surface (avoids the near-corner palette
    // cells that are doubly influenced by two collapsed borders, which cause diagonal
    // spike artifacts), blending to square-polar only at the very tip so t=1 always
    // lands on the actual collapsed border for all angles.
    const t      = i / nu
    const angle  = j / nv * 2 * Math.PI
    const ca     = Math.cos(angle)
    const sa     = Math.sin(angle)
    const sqNorm = Math.max(Math.abs(ca), Math.abs(sa))
    const norm   = 1 + (sqNorm - 1) * t ** 8   // 1 (circle) at t=0, sqNorm (square) at t=1
    return [0.5 + t * 0.5 * ca / norm, 0.5 + t * 0.5 * sa / norm]
  })
}

// Cylinder H — W:F — left/right edges glued; u wraps around, v is free height axis
export function makeCylinderH(): THREE.BufferGeometry {
  return buildParametric((u, v) => {
    const theta = u * 2 * Math.PI
    return [Math.cos(theta) * 0.35, (v - 0.5) * 0.9, Math.sin(theta) * 0.35]
  }, 64, 32)
}

// Cylinder V — F:W — top/bottom edges glued; v wraps around, u is free horizontal axis
export function makeCylinderV(): THREE.BufferGeometry {
  return buildParametric((u, v) => {
    const theta = v * 2 * Math.PI
    return [(u - 0.5) * 0.9, Math.cos(theta) * 0.35, Math.sin(theta) * 0.35]
  }, 32, 64)
}

// Dome — W:FC or FC:W — one pole, one free edge, one wrap axis
// W:FC → u wraps (theta=u), v goes equator-to-pole (phi=v·π/2)
//   pole at top (v=1) if top collapsed, pole at bottom (v=0) if bottom collapsed
// FC:W → v wraps (theta=v), u goes equator-to-pole (phi=u·π/2)
//   pole at right (u=1) if right collapsed, pole at left (u=0) if left collapsed
export function makeDome(cfg: EdgeConfig): THREE.BufferGeometry {
  const hWrap = cfg.hConnect === 'wrap'
  const flipAxis = hWrap ? cfg.bottom === 'collapsed' : cfg.left === 'collapsed'
  return buildParametric((u, v) => {
    const theta = (hWrap ? u : v) * 2 * Math.PI
    const raw   = hWrap ? v : u
    const t     = flipAxis ? 1 - raw : raw
    const phi   = t * Math.PI / 2  // 0=equator, π/2=pole
    return [
      Math.cos(phi) * Math.cos(theta) * 0.45,
      Math.sin(phi) * 0.45 - 0.22,
      Math.cos(phi) * Math.sin(theta) * 0.45,
    ]
  }, 64, 32)
}

// Sphere — W:C or C:W — both non-wrap edges collapsed to poles
// W:C → u wraps (theta=u), v goes pole-to-pole (phi=v·π)
// C:W → v wraps (theta=v), u goes pole-to-pole (phi=u·π)
export function makeSphere(cfg: EdgeConfig): THREE.BufferGeometry {
  const hWrap = cfg.hConnect === 'wrap'
  return buildParametric((u, v) => {
    const theta = (hWrap ? u : v) * 2 * Math.PI
    const phi   = (hWrap ? v : u) * Math.PI
    return [
      Math.sin(phi) * Math.cos(theta) * 0.45,
      Math.cos(phi) * 0.45,
      Math.sin(phi) * Math.sin(theta) * 0.45,
    ]
  }, 64, 32)
}

// Torus — H wrap, V wrap
export function makeTorus(): THREE.BufferGeometry {
  const R = 0.30, r = 0.15
  return buildParametric((u, v) => {
    const theta = u * 2 * Math.PI
    const phi   = v * 2 * Math.PI
    return [
      (R + r * Math.cos(phi)) * Math.cos(theta),
      r * Math.sin(phi),
      (R + r * Math.cos(phi)) * Math.sin(theta),
    ]
  }, 64, 64)
}

// Horn Torus W:K — u wraps the main circle, v collapses at the pinch point
export function makeHornTorusH(): THREE.BufferGeometry {
  const R = 0.28
  return buildParametric((u, v) => {
    const theta = u * 2 * Math.PI
    const phi   = v * 2 * Math.PI + Math.PI
    return [
      (R + R * Math.cos(phi)) * Math.cos(theta),
      R * Math.sin(phi),
      (R + R * Math.cos(phi)) * Math.sin(theta),
    ]
  }, 64, 64)
}

// Horn Torus K:W — u collapses at the pinch point, v wraps the main circle
export function makeHornTorusV(): THREE.BufferGeometry {
  const R = 0.28
  return buildParametric((u, v) => {
    const theta = v * 2 * Math.PI
    const phi   = u * 2 * Math.PI + Math.PI
    return [
      (R + R * Math.cos(phi)) * Math.cos(theta),
      R * Math.sin(phi),
      (R + R * Math.cos(phi)) * Math.sin(theta),
    ]
  }, 64, 64)
}

// Cannoli H — K:F — u is K (long axis bends into circle, tips meet), v is F (open width)
export function makeCannoliH(): THREE.BufferGeometry {
  const R = 0.22, W = 0.40
  return buildParametric((u, v) => {
    const theta = u * 2 * Math.PI
    const hw    = (v - 0.5) * Math.sin(u * Math.PI) * W
    return [
      R * Math.cos(theta),
      hw,
      R * Math.sin(theta),
    ]
  }, 128, 16)
}

// Cannoli V — F:K — v is K (long axis bends into circle, tips meet), u is F (open width)
export function makeCannoliV(): THREE.BufferGeometry {
  const R = 0.22, W = 0.40
  return buildParametric((u, v) => {
    const theta = v * 2 * Math.PI
    const hw    = (u - 0.5) * Math.sin(v * Math.PI) * W
    return [
      R * Math.cos(theta),
      hw,
      R * Math.sin(theta),
    ]
  }, 16, 128)
}


// Möbius H — T:F — u wraps with half-twist, v is the strip width
export function makeMobiusH(): THREE.BufferGeometry {
  const R = 0.32, w = 0.18
  return buildParametric((u, v) => {
    const angle = u * 2 * Math.PI
    const t     = (v - 0.5) * 2 * w
    const cosH  = Math.cos(angle / 2)
    const sinH  = Math.sin(angle / 2)
    return [
      (R + t * cosH) * Math.cos(angle),
      t * sinH,
      (R + t * cosH) * Math.sin(angle),
    ]
  }, 128, 16)
}

// Möbius V — F:T — v wraps with half-twist, u is the strip width
export function makeMobiusV(): THREE.BufferGeometry {
  const R = 0.32, w = 0.18
  return buildParametric((u, v) => {
    const angle = v * 2 * Math.PI
    const t     = (u - 0.5) * 2 * w
    const cosH  = Math.cos(angle / 2)
    const sinH  = Math.sin(angle / 2)
    return [
      (R + t * cosH) * Math.cos(angle),
      t * sinH,
      (R + t * cosH) * Math.sin(angle),
    ]
  }, 16, 128)
}

// Klein — T:W or W:T — figure-8 immersion
// a = twist axis (0..2π), b = wrap axis (0..2π)
// T:W → a=u, b=v;  W:T → a=v, b=u
export function makeKlein(cfg: EdgeConfig): THREE.BufferGeometry {
  const s = 0.18
  const hTwist = cfg.hConnect === 'twist'
  return buildParametric((u, v) => {
    const a = (hTwist ? u : v) * 2 * Math.PI
    const b = (hTwist ? v : u) * 2 * Math.PI
    const cosA = Math.cos(a), sinA = Math.sin(a)
    const cosHA = Math.cos(a / 2), sinHA = Math.sin(a / 2)
    const sinB = Math.sin(b), sin2B = Math.sin(2 * b)
    const r = 2 + cosHA * sinB - sinHA * sin2B
    return [r * cosA * s, (sinHA * sinB + cosHA * sin2B) * s, r * sinA * s]
  }, 128, 64)
}

// Boy's Surface — T:T — Kusner–Bryant parametrization (order-3 symmetric immersion of RP²)
// z = tan(π·v/2)·e^(i·2π·u) maps [0,1]² to the unit disk
// g₁ = -3/2·Im[z(1-z⁴)/(z⁶+√5·z³-1)]
// g₂ = -3/2·Re[z(1+z⁴)/(z⁶+√5·z³-1)]
// g₃ =     Im[(1+z⁶)/(z⁶+√5·z³-1)] - 1/2
// (x,y,z) = (g₁,g₂,g₃) / (g₁²+g₂²+g₃²)
export function makeBoySurface(): THREE.BufferGeometry {
  const s = 0.38
  const sq5 = Math.sqrt(5)
  const mul = (ar: number, ai: number, br: number, bi: number): [number, number] =>
    [ar*br - ai*bi, ar*bi + ai*br]
  const inv = (ar: number, ai: number): [number, number] => {
    const d = ar*ar + ai*ai; return [ar/d, -ai/d]
  }
  const compute = (u: number, v: number): [number, number, number] => {
    const r     = Math.tan(v * Math.PI / 4)
    const theta = u * 2 * Math.PI
    const zr = r * Math.cos(theta), zi = r * Math.sin(theta)
    const [z2r, z2i] = mul(zr, zi, zr, zi)
    const [z3r, z3i] = mul(z2r, z2i, zr, zi)
    const [z4r, z4i] = mul(z3r, z3i, zr, zi)
    const [z5r, z5i] = mul(z4r, z4i, zr, zi)
    const [z6r, z6i] = mul(z3r, z3i, z3r, z3i)
    const [invr, invi] = inv(z6r + sq5*z3r - 1, z6i + sq5*z3i)
    const [n1r, n1i] = mul(zr - z5r, zi - z5i, invr, invi)
    const [n2r, n2i] = mul(zr + z5r, zi + z5i, invr, invi)
    const [n3r, n3i] = mul(1 + z6r, z6i, invr, invi)
    const g1 = -1.5 * n1i
    const g2 = -1.5 * n2r
    const g3 = n3i - 0.5
    const norm = g1*g1 + g2*g2 + g3*g3
    return [g1/norm * s, g2/norm * s, g3/norm * s]
  }
  // UV: polar coords centered at (0.5, 0.5) so the wrap seam at u=0/1 maps to
  // the same palette point and v=0 (center of disk) maps to palette center.
  return buildParametric(compute, 96, 96, (i, j, nu, nv) => {
    const u = i / nu, v = j / nv
    return [
      0.5 + v * 0.5 * Math.cos(u * 2 * Math.PI),
      0.5 + v * 0.5 * Math.sin(u * 2 * Math.PI),
    ]
  })
}

// Cross-cap — T:K or K:T — standard parametrization
// u = twist axis (0..2π), v = collapses at pinch point (0..π/2)
// x = sin(u)·sin(2v)/2,  y = sin(2u)·sin²(v),  z = cos(2u)·sin²(v)  (scaled)
export function makeCrossCap(cfg: EdgeConfig): THREE.BufferGeometry {
  const s = 0.7
  const hTwist = cfg.hConnect === 'twist'
  return buildParametric((u, v) => {
    const tw = hTwist ? u : v
    const cl = hTwist ? v : u
    const a = tw * 2 * Math.PI                  // twist axis
    const b = (hTwist ? cl : Math.sin(cl * Math.PI) ) * Math.PI / 2  // collapse axis: K needs both ends to pinch
    return [
      0.5 * Math.sin(a) * Math.sin(2 * b) * s,
      0.5 * Math.sin(2 * a) * Math.sin(b) * Math.sin(b) * s,
      0.5 * Math.cos(2 * a) * Math.sin(b) * Math.sin(b) * s,
    ]
  }, 96, 64)
}

// Conch — T:FC — Möbius-like but one edge collapsed
export function makeConch(): THREE.BufferGeometry {
  const R = 0.28, w = 0.18
  return buildParametric((u, v) => {
    const angle = u * 2 * Math.PI
    const t     = v * w  // 0=collapsed pole, w=free edge (asymmetric)
    const cosH  = Math.cos(angle / 2)
    const sinH  = Math.sin(angle / 2)
    return [
      (R + t * cosH) * Math.cos(angle),
      t * sinH,
      (R + t * cosH) * Math.sin(angle),
    ]
  }, 128, 16)
}

// Roman Surface — T:C or C:T — Steiner's Roman surface
export function makeRomanSurface(): THREE.BufferGeometry {
  const s = 0.45
  return buildParametric((u, v) => {
    const a = u * Math.PI
    const b = v * Math.PI
    const cosA = Math.cos(a), sinA = Math.sin(a)
    const cosB = Math.cos(b), sinB = Math.sin(b)
    return [
      sinA * sinA * sinB * cosB * s,
      sinA * cosA * cosB * s,
      sinA * cosA * sinB * s,
    ]
  }, 64, 64)
}

// ─── Lookup by axis-state key (hAxis:vAxis) ────────────────────────────────────
// Keyed by 'H:V' so that topologies with the same name but different orientations
// (e.g. W:F vs F:W Cylinder) can resolve to distinct geometries.

export type MeshBuilder = (cfg: EdgeConfig) => THREE.BufferGeometry

// Wrap cfg-ignorant builders so all entries share the same signature
const geo = (fn: () => THREE.BufferGeometry): MeshBuilder => () => fn()

export const TOPOLOGY_MESH_BUILDERS: Record<string, MeshBuilder> = {
  'F:F':   geo(makeRectangle),
  // Ogive — receives cfg so it knows which specific edge is collapsed
  'FC:F':  makeOgiveH,
  'F:FC':  makeOgiveV,
  // Lens — flat, poles at left/right (C:F) or top/bottom (F:C)
  'C:F':   geo(makeLensH),
  'F:C':   geo(makeLensV),
  // Canoe — both axes FC (receives cfg so it knows which specific corner is collapsed)
  'FC:FC': makeCanoe,
  // Saucière — receives cfg so it knows which edge is free
  'FC:C':  makeSauciere,
  'C:FC':  makeSauciere,
  'FC:K':  makeSauciere,
  'K:FC':  makeSauciere,
  // Teardrop — both C, or C + K
  'C:C':   geo(makeTeardrop),
  'C:K':   geo(makeTeardrop),
  'K:C':   geo(makeTeardrop),
  // Cylinder — orientation matters: W:F wraps u (horizontal), F:W wraps v (vertical)
  'W:F':   geo(makeCylinderH),
  'F:W':   geo(makeCylinderV),
  // Dome
  'W:FC':  makeDome,
  'FC:W':  makeDome,
  // Sphere
  'W:C':   makeSphere,
  'C:W':   makeSphere,
  // Torus
  'W:W':   geo(makeTorus),
  // Horn Torus
  'W:K':   geo(makeHornTorusH),
  'K:W':   geo(makeHornTorusV),
  // Cannoli
  'K:F':   geo(makeCannoliH),
  'F:K':   geo(makeCannoliV),
  // Tortellini — same topology as teardrop
  'K:K':   geo(makeTeardrop),
  // Möbius
  'T:F':   geo(makeMobiusH),
  'F:T':   geo(makeMobiusV),
  // Klein
  'T:W':   makeKlein,
  'W:T':   makeKlein,
  // Boy's Surface
  'T:T':   geo(makeBoySurface),
  // Cross-cap
  'T:K':   makeCrossCap,
  'K:T':   makeCrossCap,
  // Conch
  'T:FC':  geo(makeConch),
  'FC:T':  geo(makeConch),
  // Roman Surface
  'T:C':   geo(makeRomanSurface),
  'C:T':   geo(makeRomanSurface),
}
