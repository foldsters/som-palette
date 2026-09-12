import { useState, useRef, useEffect, useCallback, useMemo, type PointerEvent as ReactPointerEvent } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { type EdgeConfig, DEFAULT_CONFIG, getTopology, getTopologyKey, gridDistance } from './topology'
import { TOPOLOGY_MESH_BUILDERS } from './meshes'
import { GLSOM } from './glSOM'
import { NUDIBRANCHS } from './nudibranchs'
import { type Theme, deriveTheme, MODAL_SCRIM } from '../theme'

const DEFAULT_ITERATIONS = 500
const DISPLAY = 600  // palette display size in px

// ─── SOM ─────────────────────────────────────────────────────────────────────

function initPalette(imageData: ImageData, rows: number, cols: number): Float32Array {
  const { width, height, data } = imageData
  const totalPx = width * height
  const palette = new Float32Array(rows * cols * 3)
  for (let i = 0; i < rows * cols; i++) {
    const pi = Math.floor(Math.random() * totalPx) * 4
    palette[i * 3]     = data[pi]     / 255
    palette[i * 3 + 1] = data[pi + 1] / 255
    palette[i * 3 + 2] = data[pi + 2] / 255
  }
  return palette
}

function runSOMBatch(
  palette: Float32Array,
  imageData: ImageData,
  rows: number, cols: number,
  fromIter: number, toIter: number, totalIter: number,
  cfg: EdgeConfig,
  blendDecay = 0.5,
  radiusDecay = 0.5,
) {
  const { width, height, data } = imageData
  const totalPx = width * height
  const maxRadius = Math.max(rows, cols) / 2
  const blendExp  = Math.pow(10, 2 * blendDecay - 1)
  const radiusExp = Math.pow(10, 2 * radiusDecay - 1)

  for (let iter = fromIter; iter < toIter; iter++) {
    const t      = iter / (totalIter - 1)
    const tBlend  = Math.pow(t, blendExp)
    const tRadius = Math.pow(t, radiusExp)
    const lr     = 0.5 * (1 - tBlend)
    const sigma  = maxRadius * (1 - tRadius) + 0.5
    const sigma2 = 2 * sigma * sigma
    const cutoff = sigma * 3

    const pi = Math.floor(Math.random() * totalPx) * 4
    const pr = data[pi] / 255, pg = data[pi + 1] / 255, pb = data[pi + 2] / 255

    let bmuIdx = 0, bmuDist = Infinity
    for (let i = 0; i < rows * cols; i++) {
      const dr = palette[i * 3] - pr
      const dg = palette[i * 3 + 1] - pg
      const db = palette[i * 3 + 2] - pb
      const d  = dr * dr + dg * dg + db * db
      if (d < bmuDist) { bmuDist = d; bmuIdx = i }
    }
    const bmuR = Math.floor(bmuIdx / cols)
    const bmuC = bmuIdx % cols

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dist = gridDistance(r, c, bmuR, bmuC, rows, cols, cfg)
        if (dist >= cutoff) continue
        const influence = lr * Math.exp(-dist * dist / sigma2)
        const idx = (r * cols + c) * 3
        palette[idx]     += influence * (pr - palette[idx])
        palette[idx + 1] += influence * (pg - palette[idx + 1])
        palette[idx + 2] += influence * (pb - palette[idx + 2])
      }
    }
  }
}

function renderPalette(canvas: HTMLCanvasElement, palette: Float32Array, rows: number, cols: number) {
  canvas.width  = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(cols, rows)
  for (let i = 0; i < rows * cols; i++) {
    img.data[i * 4]     = Math.round(palette[i * 3]     * 255)
    img.data[i * 4 + 1] = Math.round(palette[i * 3 + 1] * 255)
    img.data[i * 4 + 2] = Math.round(palette[i * 3 + 2] * 255)
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

// ─── Arrow edge model ─────────────────────────────────────────────────────────
//
// Each edge has an arrow state. The arrow direction encodes pinch and join info.
//
//   Top:    ↑ = pinch+join (out), ↓ = pinch no-join (in), ←/→ = lateral join, — = free
//   Bottom: ↓ = pinch+join (out), ↑ = pinch no-join (in), ←/→ = lateral join, — = free
//   Left:   ← = pinch+join (out), → = pinch no-join (in), ↑/↓ = lateral join, — = free
//   Right:  → = pinch+join (out), ← = pinch no-join (in), ↑/↓ = lateral join, — = free

type Arrow = 'up' | 'down' | 'left' | 'right' | 'none'

interface Arrows {
  top: Arrow
  bottom: Arrow
  left: Arrow
  right: Arrow
}

const DEFAULT_ARROWS: Arrows = { top: 'none', bottom: 'none', left: 'none', right: 'none' }

function arrowsToCfg(a: Arrows): EdgeConfig {
  // Each edge is pinched if it has any pinch arrow (outward or inward)
  const top    = (a.top    === 'up'    || a.top    === 'down')  ? 'pinched' : 'open'
  const bottom = (a.bottom === 'down'  || a.bottom === 'up')    ? 'pinched' : 'open'
  const left   = (a.left   === 'left'  || a.left   === 'right') ? 'pinched' : 'open'
  const right  = (a.right  === 'right' || a.right  === 'left')  ? 'pinched' : 'open'

  // V axis connection
  const vPinchJoin = a.top === 'up'   && a.bottom === 'down'
  const vLateral   = (a.top === 'left' || a.top === 'right') && (a.bottom === 'left' || a.bottom === 'right')
  let vJoin: 'free' | 'wrap' | 'twist' = 'free'
  if (vPinchJoin) vJoin = 'wrap'
  if (vLateral)   vJoin = a.top === a.bottom ? 'wrap' : 'twist'

  // H axis connection
  const hPinchJoin = a.left === 'left' && a.right === 'right'
  const hLateral   = (a.left === 'up' || a.left === 'down') && (a.right === 'up' || a.right === 'down')
  let hJoin: 'free' | 'wrap' | 'twist' = 'free'
  if (hPinchJoin) hJoin = 'wrap'
  if (hLateral)   hJoin = a.left === a.right ? 'wrap' : 'twist'

  // Twist on one axis forces the other axis's pinch to be joined
  // (twisted identification reverses orientation, so opposite pinched edges must meet)
  if (hJoin === 'twist' && top === 'pinched' && bottom === 'pinched') vJoin = 'wrap'
  if (vJoin === 'twist' && left === 'pinched' && right === 'pinched') hJoin = 'wrap'

  return { top, bottom, left, right, hJoin, vJoin }
}

// Forcing rules when setting an arrow on an edge
// Outward/inward arrows per edge
const OUTWARD: Record<keyof Arrows, Arrow> = { top: 'up',    bottom: 'down', left: 'left',  right: 'right' }
const INWARD:  Record<keyof Arrows, Arrow> = { top: 'down',  bottom: 'up',   left: 'right', right: 'left'  }
const OPPOSITE: Record<keyof Arrows, keyof Arrows> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function setArrow(arrows: Arrows, edge: keyof Arrows, arrow: Arrow): Arrows {
  const next = { ...arrows, [edge]: arrow }
  const opp = OPPOSITE[edge]

  if (arrow === OUTWARD[edge]) {
    // Outward: force opposite outward
    next[opp] = OUTWARD[opp]
  } else if (arrow === INWARD[edge]) {
    if (arrows[opp] === OUTWARD[opp]) {
      // Inward when opposite was outward (K pair): force opposite inward too
      next[opp] = INWARD[opp]
    } else {
      // Inward otherwise: clear opposite if it was lateral
      const isHEdge = edge === 'top' || edge === 'bottom'
      const oppIsLateral = isHEdge
        ? (arrows[opp] === 'left' || arrows[opp] === 'right')
        : (arrows[opp] === 'up'   || arrows[opp] === 'down')
      if (oppIsLateral) next[opp] = 'none'
    }
  } else if (arrow === 'none') {
    if (arrows[opp] === OUTWARD[opp]) {
      // Opposite was outward (K pair): force it inward
      next[opp] = INWARD[opp]
    } else if (arrows[opp] === INWARD[opp] && arrows[edge] !== INWARD[edge]) {
      // Opposite was inward but this edge wasn't (independent single pinch): clear it
      next[opp] = 'none'
    } else {
      // Opposite was lateral (wrap/twist): clear it too
      const isHEdge = edge === 'top' || edge === 'bottom'
      const oppIsLateral = isHEdge
        ? (arrows[opp] === 'left' || arrows[opp] === 'right')
        : (arrows[opp] === 'up'   || arrows[opp] === 'down')
      if (oppIsLateral) next[opp] = 'none'
    }
  } else {
    // Lateral: only applies to arrows orthogonal to this edge's axis
    const isHEdge = edge === 'top' || edge === 'bottom'
    const isLateral = isHEdge ? (arrow === 'left' || arrow === 'right') : (arrow === 'up' || arrow === 'down')
    if (isLateral) {
      const oppLateral = isHEdge
        ? (arrow === 'left' ? 'right' : 'left')
        : (arrow === 'up' ? 'down' : 'up')
      if (next[opp] !== oppLateral) next[opp] = arrow
    }
  }

  // Cannoli: if one axis just became fully neutral and the other has both edges pinched outward, force the pinched axis outward
  // (only trigger when the change was on the neutral axis, not when we're adjusting the pinched axis itself)
  const hNeutral = next.left === 'none' && next.right === 'none'
  const vNeutral = next.top  === 'none' && next.bottom === 'none'
  const vBothPinched = next.top === 'up' && next.bottom === 'down'
  const hBothPinched = next.left === 'left' && next.right === 'right'
  const changingHAxis = edge === 'left' || edge === 'right'
  const changingVAxis = edge === 'top'  || edge === 'bottom'
  if (hNeutral && vBothPinched && changingHAxis) { next.top = 'up'; next.bottom = 'down' }
  if (vNeutral && hBothPinched && changingVAxis) { next.left = 'left'; next.right = 'right' }

  return next
}

// Arrow symbols for display
const ARROW_GLYPH: Record<Arrow, string> = {
  up: '↑', down: '↓', left: '←', right: '→', none: '·',
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TIER_COLOR: Record<string, string> = {
  common:       '#666',
  intermediate: '#7a9cc0',
  exotic:       '#9c7ac0',
}


function segBtn(T: Theme, active: boolean): React.CSSProperties {
  return {
    padding: '3px 10px',
    border: `1px solid ${active ? T.accent : T.border}`,
    borderRadius: '3px',
    background: active ? T.border : 'transparent',
    color: active ? T.accent : T.muted,
    fontSize: '9px',
    cursor: 'pointer',
    fontFamily: 'monospace',
    letterSpacing: '0.05em',
  }
}

// Header icon button (light toggle / chroma / help)
function iconBtn(T: Theme, active = false): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: '6px',
    border: `1px solid ${active ? T.accent : T.border}`,
    background: active ? T.border : 'transparent',
    color: T.text,
    cursor: 'pointer',
    fontFamily: 'monospace',
    fontSize: '16px',
    lineHeight: 1,
  }
}

// ─── 3D topology viewer ───────────────────────────────────────────────────────

interface TopoMeshProps {
  topologyKey: string
  cfg: EdgeConfig
  paletteCanvasRef: React.RefObject<HTMLCanvasElement | null>
  paletteReady: boolean
  offsetX: number
  offsetY: number
  flipUV: boolean
  morphT: number
}

function TopoMeshScene({ topologyKey, cfg, paletteCanvasRef, paletteReady, offsetX, offsetY, flipUV, morphT }: TopoMeshProps) {
  const meshRef    = useRef<THREE.Mesh>(null)
  const texRef     = useRef<THREE.CanvasTexture | null>(null)
  const texSizeRef = useRef<[number, number]>([0, 0])

  const { gl } = useThree()

  const geometry = useMemo(() => {
    const builder = TOPOLOGY_MESH_BUILDERS[topologyKey]
    return builder ? builder(cfg) : TOPOLOGY_MESH_BUILDERS['F:F'](cfg)
  }, [topologyKey, cfg])

  // Reset texture when the GL renderer changes (e.g. after HMR remounts the Canvas)
  useEffect(() => {
    texRef.current = null
    texSizeRef.current = [0, 0]
  }, [gl])

  // Lerp positions between flat (morphT=0) and shaped (morphT=1)
  useEffect(() => {
    const pos  = geometry.getAttribute('position') as THREE.BufferAttribute
    const flat = geometry.getAttribute('flatPosition') as THREE.BufferAttribute
    if (!flat) return
    const shaped = pos.array as Float32Array
    const flatArr = flat.array as Float32Array
    if (!(geometry as any)._shapedPos) {
      (geometry as any)._shapedPos = new Float32Array(shaped)
    }
    const shapedOrig: Float32Array = (geometry as any)._shapedPos
    const circ = geometry.getAttribute('circlePosition') as THREE.BufferAttribute | null
    const circArr = circ ? circ.array as Float32Array : null
    for (let i = 0; i < shapedOrig.length; i += 3) {
      let ax, ay, az, bx, by, bz, t
      if (circArr) {
        if (morphT <= 0.5) {
          t = morphT * 2
          ax = flatArr[i];    ay = flatArr[i+1];    az = flatArr[i+2]
          bx = circArr[i];    by = circArr[i+1];    bz = circArr[i+2]
        } else {
          t = (morphT - 0.5) * 2
          ax = circArr[i];    ay = circArr[i+1];    az = circArr[i+2]
          bx = shapedOrig[i]; by = shapedOrig[i+1]; bz = shapedOrig[i+2]
        }
      } else {
        t = morphT
        ax = flatArr[i];    ay = flatArr[i+1];    az = flatArr[i+2]
        bx = shapedOrig[i]; by = shapedOrig[i+1]; bz = shapedOrig[i+2]
      }
      shaped[i]   = ax + (bx - ax) * t
      shaped[i+1] = ay + (by - ay) * t
      shaped[i+2] = az + (bz - az) * t
    }
    pos.needsUpdate = true
    geometry.computeVertexNormals()

    // Cull inner triangles when morphT is between 0 and 1
    const idx = geometry.getIndex()
    if (!idx) return
    if (!(geometry as any)._fullIndex) {
      (geometry as any)._fullIndex = idx.array.slice()
    }
    const full = (geometry as any)._fullIndex as Uint32Array
    if (morphT === 0 || morphT === 1) {
      idx.set(full)
      ;(idx as any).count = full.length
    } else {
      const threshold = 0.42
      const filtered: number[] = []
      for (let i = 0; i < full.length; i += 3) {
        const a = full[i], b = full[i+1], c = full[i+2]
        const outside = (vi: number) => {
          const x = Math.abs(flatArr[vi*3]), y = Math.abs(flatArr[vi*3+1])
          return Math.max(x, y) > threshold
        }
        if (outside(a) || outside(b) || outside(c)) filtered.push(a, b, c)
      }
      for (let i = 0; i < full.length; i++) (idx.array as any)[i] = i < filtered.length ? filtered[i] : 0
      ;(idx as any).count = filtered.length
    }
    idx.needsUpdate = true
  }, [geometry, morphT])

  // Swap uv ↔ uvTransposed for true u/v transpose
  useEffect(() => {
    const uvNormal     = geometry.getAttribute('uvNormal') ?? geometry.getAttribute('uv')
    const uvTransposed = geometry.getAttribute('uvTransposed')
    if (!uvNormal || !uvTransposed) return
    // Keep uvNormal as a stable backup
    if (!geometry.getAttribute('uvNormal')) geometry.setAttribute('uvNormal', uvNormal)
    geometry.setAttribute('uv', flipUV ? uvTransposed : uvNormal)
  }, [geometry, flipUV])

  // Update texture from palette canvas each frame when ready
  useFrame(() => {
    const canvas = paletteCanvasRef.current
    const mesh   = meshRef.current
    if (!canvas || !mesh || !canvas.width || !canvas.height) return
    const mat = mesh.material as THREE.MeshBasicMaterial
    const [tw, th] = texSizeRef.current
    if (!texRef.current || texRef.current.image !== canvas ||
        tw !== canvas.width || th !== canvas.height) {
      texRef.current?.dispose()
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      texRef.current = tex
      texSizeRef.current = [canvas.width, canvas.height]
    }
    // Re-wire the map whenever the material was recreated (e.g. after HMR)
    if (mat.map !== texRef.current) {
      mat.map = texRef.current
      mat.needsUpdate = true
    }
    texRef.current.needsUpdate = true
  })

  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    []
  )

  return (
    <>
      <mesh ref={meshRef} geometry={geometry} material={material} />
<OrbitControls enablePan={false} />
    </>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [arrows, setArrows]       = useState<Arrows>(DEFAULT_ARROWS)
  const cfg                       = useMemo(() => arrowsToCfg(arrows), [arrows])
  const [imageData, setImageData] = useState<ImageData | null>(null)
  const [running, setRunning]     = useState(false)
  const [rows, setRows]           = useState(64)
  const [cols, setCols]           = useState(64)
  const [iterations, setIterations] = useState(DEFAULT_ITERATIONS)
  const [rowsInput, setRowsInput] = useState('64')
  const [colsInput, setColsInput] = useState('64')
  const [iterInput, setIterInput] = useState(String(DEFAULT_ITERATIONS))
  const [redrawKey, setRedrawKey]       = useState(0)
  const [paletteReady, setPaletteReady] = useState(false)
  const [useGPU, setUseGPU]            = useState(true)
  const [attribution, setAttribution]   = useState<string | null>(null)
  const [offsetX, setOffsetX]           = useState(0)
  const [offsetY, setOffsetY]           = useState(0)
  const [flipUV, setFlipUV]             = useState(false)
  const [morphT, setMorphT]             = useState(1)
  type DragState = { edge: keyof Arrows; snapped: Arrow; dx: number; dy: number; cx: number; cy: number }
  const [dragState, setDragState]       = useState<DragState | null>(null)
  const dragRef                         = useRef<DragState | null>(null)
  const gridDragRef                     = useRef<{ startX: number; startY: number; baseRows: number; baseCols: number } | null>(null)
  const [gridDragging, setGridDragging] = useState(false)
  const iterDragRef                     = useRef<{ startX: number; startY: number; baseQuality: number } | null>(null)
  const [iterDragging, setIterDragging] = useState(false)
  const [blendDecay, setBlendDecay]     = useState(0.5)
  const [radiusDecay, setRadiusDecay]   = useState(0.5)
  const decayDragRef                    = useRef<{ startX: number; startY: number; baseBlend: number; baseRadius: number } | null>(null)
  const [decayDragging, setDecayDragging] = useState(false)
  const imageCanvasRef                  = useRef<HTMLCanvasElement>(null)
  const paletteCanvasRef                = useRef<HTMLCanvasElement>(null)
  const genRef                          = useRef(0)
  const glRef                           = useRef<GLSOM | null>(null)

  // ─── Theme (light/dark + palette-tinted chroma) ───────────────────────────────
  const [lightMode, setLightMode]       = useState(false)
  const [chromaMode, setChromaMode]     = useState(false)
  const [showInfo, setShowInfo]         = useState(false)
  const [paletteCorners, setPaletteCorners] = useState<Float32Array | null>(null)
  const T = deriveTheme(chromaMode ? paletteCorners : null, lightMode)

  // Paint the whole page (not just the centered column) to match the theme.
  useEffect(() => {
    document.documentElement.style.background = T.bg
    document.body.style.background = T.bg
  }, [T.bg])

  // Escape closes the info modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowInfo(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const topology    = getTopology(cfg)
  const topologyKey = getTopologyKey(cfg)

  const loadImage = useCallback((src: string, attr?: string) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = imageCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      setImageData(ctx.getImageData(0, 0, canvas.width, canvas.height))
      setAttribution(attr ?? null)
    }
    img.src = src
  }, [])

  const loadRandom = useCallback(() => {
    const p = NUDIBRANCHS[Math.floor(Math.random() * NUDIBRANCHS.length)]
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onerror = () => loadRandom()  // CORS blocked — silently try another
    img.onload = () => {
      const canvas = imageCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      setImageData(ctx.getImageData(0, 0, canvas.width, canvas.height))
      setAttribution(`${p.name} · ${p.sci} · iNaturalist (CC)`)
    }
    img.src = p.url
  }, [])

  // Load default image
  useEffect(() => { loadImage(`${import.meta.env.BASE_URL}default.jpeg`) }, [loadImage])

  // Auto-extract whenever image, config, grid size, or redraw key changes
  useEffect(() => {
    if (!imageData) return
    const gen = ++genRef.current
    const batchSize = Math.max(1, Math.ceil(iterations / 120)) // ~120 frames
    let iter = 0
    let rafId: number
    setRunning(true)
    setPaletteReady(false)

    // Initialise palette on CPU; upload to GPU if available
    const palette = initPalette(imageData, rows, cols)

    // Try to (re)use a GLSOM instance
    let gl = glRef.current
    if (useGPU) {
      if (!gl && GLSOM.isSupported()) {
        try { gl = new GLSOM(); glRef.current = gl } catch { gl = null }
      }
    } else {
      gl = null
    }
    if (gl) {
      gl.init(rows, cols)
      gl.cpuMirror.set(palette)
      gl.uploadMirror()
    }

    function tick() {
      if (gen !== genRef.current) return
      const to = Math.min(iter + batchSize, iterations)

      if (gl) {
        gl.runBatch(imageData!, iter, to, iterations, cfg)
        // Render from GPU mirror (one batch stale — fine for display)
        const canvas = paletteCanvasRef.current
        if (canvas) renderPalette(canvas, gl.cpuMirror, rows, cols)
      } else {
        runSOMBatch(palette, imageData!, rows, cols, iter, to, iterations, cfg, blendDecay, radiusDecay)
        const canvas = paletteCanvasRef.current
        if (canvas) renderPalette(canvas, palette, rows, cols)
      }

      iter = to
      if (iter < iterations) {
        rafId = requestAnimationFrame(tick)
      } else {
        if (gl) gl.flush()
        setRunning(false)
        setPaletteReady(true)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(rafId); ++genRef.current }
  }, [imageData, cfg, rows, cols, iterations, redrawKey, useGPU, blendDecay, radiusDecay])

  // Sample the four palette corners (TL, TR, BL, BR) to tint the UI in chroma mode.
  useEffect(() => {
    if (!paletteReady) return
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width: c, height: r } = canvas
    if (c < 1 || r < 1) return
    const corners = new Float32Array(12)
    const pts: [number, number][] = [[0, 0], [c - 1, 0], [0, r - 1], [c - 1, r - 1]]
    pts.forEach(([x, y], k) => {
      const d = ctx.getImageData(x, y, 1, 1).data
      corners[k * 3]     = d[0] / 255
      corners[k * 3 + 1] = d[1] / 255
      corners[k * 3 + 2] = d[2] / 255
    })
    setPaletteCorners(corners)
  }, [paletteReady, rows, cols, redrawKey])

  // ─── Edge interaction ───────────────────────────────────────────────────────

  // Global pointer handlers: track drag position and commit on release anywhere
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // Export drag
      const ed = exportDragRef.current
      if (ed) {
        const dy = e.clientY - ed.startY
        ed.dy = dy
        setExportDragY(dy)
        return
      }
      // Decay drag
      const dd = decayDragRef.current
      if (dd) {
        const PX_PER_UNIT = 120
        setBlendDecay(Math.max(0, Math.min(1, dd.baseBlend + (e.clientX - dd.startX) / PX_PER_UNIT)))
        setRadiusDecay(Math.max(0, Math.min(1, dd.baseRadius + (e.clientY - dd.startY) / PX_PER_UNIT)))
        return
      }
      // Iter drag
      const id = iterDragRef.current
      if (id) {
        const PX_PER_STEP = 8
        const delta = (e.clientX - id.startX + e.clientY - id.startY) / PX_PER_STEP * 0.1
        const quality = Math.max(0, Math.min(10, id.baseQuality + delta))
        setIterations(Math.max(1, Math.round(Math.pow(10, quality / 2))))
        return
      }
      // Grid size drag
      const gd = gridDragRef.current
      if (gd) {
        const PX_PER_STEP = 20
        const pow2 = (base: number, steps: number) => {
          const exp = Math.round(Math.log2(base)) + steps
          return Math.pow(2, Math.max(0, Math.min(12, exp)))  // 1..4096
        }
        const dc = Math.round((e.clientX - gd.startX) / PX_PER_STEP)
        const dr = Math.round((e.clientY - gd.startY) / PX_PER_STEP)
        setCols(pow2(gd.baseCols, dc))
        setRows(pow2(gd.baseRows, dr))
        return
      }
      const ds = dragRef.current
      if (!ds) return
      const { cx, cy, edge } = ds
      const ddx = e.clientX - cx
      const ddy = e.clientY - cy
      const snapped = (() => {
        const DEAD = 12
        const mag = Math.sqrt(ddx * ddx + ddy * ddy)
        if (mag < DEAD) return 'none' as Arrow
        let out: number, lat: number
        if (edge === 'top')         { out = -ddy; lat = ddx }
        else if (edge === 'bottom') { out = ddy;  lat = ddx }
        else if (edge === 'left')   { out = -ddx; lat = ddy }
        else                        { out = ddx;  lat = ddy }
        if (Math.abs(out) >= Math.abs(lat)) return out > 0 ? OUTWARD[edge] : INWARD[edge]
        if (edge === 'top' || edge === 'bottom') return lat < 0 ? 'left' as Arrow : 'right' as Arrow
        return lat < 0 ? 'up' as Arrow : 'down' as Arrow
      })()
      const next = { ...ds, snapped, dx: ddx, dy: ddy }
      dragRef.current = next
      setDragState(next)
    }
    const onUp = () => {
      if (exportDragRef.current) {
        const dy = exportDragRef.current.dy
        exportDragRef.current = null
        setExportDragY(null)
        if (dy > 30 && dy <= 90) exportPNG()
        else if (dy > 90) exportGPL()
        return
      }
      if (decayDragRef.current) { decayDragRef.current = null; setDecayDragging(false); return }
      if (iterDragRef.current) { iterDragRef.current = null; setIterDragging(false); return }
      if (gridDragRef.current) { gridDragRef.current = null; setGridDragging(false); return }
      const ds = dragRef.current
      if (!ds) return
      dragRef.current = null
      setDragState(null)
      const { edge, snapped, dx, dy } = ds
      if (dx === 0 && dy === 0) {
        // Pure click: force this edge to neutral, no cascade
        setArrows(a => ({ ...a, [edge]: 'none' }))
      } else {
        const forced = (edge === 'left' || edge === 'right')
          ? (cfg.left === 'pinched' && cfg.right === 'pinched' && (cfg.top === 'pinched' || cfg.bottom === 'pinched' || cfg.vJoin === 'twist'))
          : (cfg.top  === 'pinched' && cfg.bottom === 'pinched' && (cfg.left === 'pinched' || cfg.right === 'pinched' || cfg.hJoin === 'twist'))
        if (forced && (snapped === INWARD[edge] || snapped === OUTWARD[edge])) {
          setArrows(a => setArrow(a, edge, 'none'))
        } else {
          setArrows(a => setArrow(a, edge, snapped))
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [cfg])

  // ─── Export ─────────────────────────────────────────────────────────────────

  const exportPNG = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'palette.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [])

  const exportGPL = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width: c, height: r } = canvas
    const px = ctx.getImageData(0, 0, c, r).data
    const lines = ['GIMP Palette', 'Name: SOM Palette', `Columns: ${c}`, '#']
    for (let i = 0; i < r * c; i++) {
      const ri = px[i*4], gi = px[i*4+1], bi = px[i*4+2]
      lines.push(`${ri.toString().padStart(3)} ${gi.toString().padStart(3)} ${bi.toString().padStart(3)}\tUntitled`)
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const link = document.createElement('a')
    link.download = 'palette.gpl'
    link.href = URL.createObjectURL(blob)
    link.click()
    URL.revokeObjectURL(link.href)
  }, [])

  // Export drag handle state — drag distance maps to menu item selection
  const [exportDragY, setExportDragY] = useState<number | null>(null)
  const exportDragRef = useRef<{ startY: number; dy: number } | null>(null)

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, padding: '24px', fontFamily: 'monospace', display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', transition: 'background 0.2s' }}>

      {/* Theme + help controls (top right) */}
      <div style={{ position: 'absolute', top: '20px', right: '20px', display: 'flex', gap: '8px', zIndex: 20 }}>
        <button onClick={() => setLightMode(m => !m)} style={iconBtn(T)} title="Toggle light / dark">
          {lightMode ? '◑' : '◐'}
        </button>
        <button onClick={() => setChromaMode(m => !m)} style={iconBtn(T, chromaMode)} title="Tint the UI from the palette's corner colors">
          ✦
        </button>
        <button onClick={() => setShowInfo(true)} style={iconBtn(T)} title="About this app">?</button>
      </div>

      <div style={{ fontSize: '10px', letterSpacing: '0.15em', color: T.muted, marginBottom: '16px' }}>
        SOM PALETTE · TOPOLOGY SANDBOX
      </div>

      {/* Info modal */}
      {showInfo && (
        <div
          onClick={() => setShowInfo(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: MODAL_SCRIM,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '24px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position: 'relative',
              background: T.panel, border: `1px solid ${T.border}`,
              borderRadius: '12px', padding: '28px 32px',
              maxWidth: '900px', width: '100%', maxHeight: '80vh',
              overflowY: 'auto', color: T.text, fontSize: '13px', lineHeight: '1.6',
              backdropFilter: 'blur(8px)',
            }}
          >
            <button onClick={() => setShowInfo(false)} style={{ ...iconBtn(T), position: 'absolute', top: '16px', right: '16px', padding: '3px 10px', fontSize: '14px' }}>✕</button>
            <h2 style={{ color: T.accent, fontSize: '15px', fontWeight: 'normal', letterSpacing: '0.1em', marginBottom: '20px', paddingRight: '40px' }}>
              TOPOLOGY SANDBOX
            </h2>

            <p style={{ color: T.muted, marginBottom: '14px' }}>
              A{' '}
              <a href="https://en.wikipedia.org/wiki/Self-organizing_map" target="_blank" rel="noopener noreferrer" style={{ color: T.accent, textDecoration: 'none' }}>
                <strong style={{ color: T.accent }}>Self-Organizing Map (SOM)</strong>
              </a>
              {' '}is trained on an image to fold a grid of color cells through color space until it covers the
              image's palette. This sandbox lets you wrap that palette grid onto a chosen{' '}
              <strong style={{ color: T.accent }}>topological surface</strong> by setting how the grid's four
              edges identify with one another — building cylinders, Möbius bands, tori, Klein bottles, and more.
            </p>
            <p style={{ color: T.muted, marginBottom: '20px' }}>
              The edges you join don't only reshape the 3D mesh — they change how the SOM's neighbourhood wraps
              during training, so the palette itself becomes seamless across whatever surface you build.
            </p>

            {[
              ['BASIC USAGE', [
                ['Load an image', 'image uploads a file; nudibranch loads a random nudibranch photo; a default image loads on start.'],
                ['Grid size', 'ROWS × COLS set how many palette cells are trained. Also draggable from the palette\'s bottom-right corner.'],
                ['Iterations', 'ITER sets how many training samples are drawn. Also draggable from the palette\'s top-left corner.'],
                ['Redraw', 'Re-runs training. gpu / cpu toggles the WebGL2 accelerator (falls back to CPU when unsupported).'],
                ['Export', 'Drag the palette\'s top-right corner handle downward — a short drag saves a PNG, a longer drag a GIMP .gpl palette.'],
              ]],
              ['EDGE IDENTIFICATION', [
                ['Set an edge', 'Drag outward from any of the four palette edges. The direction you drag sets how that edge identifies with its opposite.'],
                ['Outward pinch', 'Arrow points out: the edge collapses to a point and joins its opposite pinched edge (wrap).'],
                ['Inward pinch', 'Arrow points in: the edge collapses to a point without joining the opposite edge.'],
                ['Lateral wrap / twist', 'A sideways arrow wraps the edge onto its opposite side — same direction on both edges = a clean wrap, opposite directions = a half-twist (non-orientable).'],
                ['Free edge', 'No arrow: the edge stays open. Opposite edges auto-update to keep the identification consistent; a ↔ or ↕ marks an axis that has become fully joined.'],
              ]],
              ['SURFACES', [
                ['What you build', 'Edge combinations yield named surfaces — rectangle, cylinder, Möbius band, torus, Klein bottle, sphere, projective plane, cone, bicone, and more.'],
                ['Rarity tier', 'The label under the mesh (common / intermediate / exotic) reflects how unusual the resulting surface is.'],
              ]],
              ['MESH & TRAINING', [
                ['Shape', 'Morphs the 3D panel between the flat palette grid and the fully shaped surface.'],
                ['U / V', 'Offset the palette texture around the surface; flip u↔v swaps the two texture axes.'],
                ['Decay', 'Drag the palette\'s bottom-left corner: b = blend (learning-rate) decay, r = radius (neighbourhood) decay. 0.5 is linear.'],
              ]],
            ].map(([heading, secRows]) => (
              <div key={heading as string} style={{ marginBottom: '20px' }}>
                <div style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em', marginBottom: '10px' }}>
                  {heading as string}
                </div>
                {(secRows as [string, string][]).map(([term, desc]) => (
                  <div key={term} style={{ display: 'flex', gap: '12px', marginBottom: '7px', flexWrap: 'wrap' }}>
                    <span style={{ color: T.accent, minWidth: '170px', flexShrink: 0, fontSize: '12px' }}>{term}</span>
                    <span style={{ color: T.muted, whiteSpace: 'pre-line', flex: 1, minWidth: '180px' }}>{desc}</span>
                  </div>
                ))}
              </div>
            ))}

            <div style={{ borderTop: `1px solid ${T.border}`, marginTop: '8px', paddingTop: '16px', color: T.muted, fontSize: '11px' }}>
              Made by{' '}
              <a
                href="https://bsky.app/profile/foldster.bsky.social"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: T.accent, textDecoration: 'none' }}
              >
                Foldster's Projects, LLC
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '24px', justifyContent: 'center' }}>
        {([
          { label: 'ROWS', value: rowsInput, set: setRowsInput, commit: (v: number) => { if (v > 0) setRows(v) } },
          { label: 'COLS', value: colsInput, set: setColsInput, commit: (v: number) => { if (v > 0) setCols(v) } },
          { label: 'ITER', value: iterInput, set: setIterInput, commit: (v: number) => { if (v > 0 && v <= 100000) setIterations(v) } },
        ]).map(({ label, value, set, commit }) => (
          <div key={label} style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
            <span style={{ fontSize: '9px', color: T.muted, letterSpacing: '0.1em' }}>{label}</span>
            <input
              type="text"
              value={value}
              onChange={e => set(e.target.value)}
              onBlur={() => commit(parseInt(value))}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              style={{
                width: '52px', padding: '3px 6px', background: T.paletteBg,
                border: `1px solid ${T.border}`, borderRadius: '3px',
                color: T.text, fontSize: '11px', fontFamily: 'monospace',
              }}
            />
          </div>
        ))}
        <button
          onClick={() => setRedrawKey(k => k + 1)}
          disabled={running}
          style={{ ...segBtn(T, false), color: running ? T.muted : T.text, padding: '4px 12px' }}
        >
          {running ? 'running…' : 'redraw'}
        </button>
        <button
          onClick={() => { setUseGPU(g => !g); setRedrawKey(k => k + 1) }}
          disabled={running}
          style={{ ...segBtn(T, useGPU), padding: '4px 12px' }}
        >
          {useGPU ? 'gpu' : 'cpu'}
        </button>
        <button
          onClick={loadRandom}
          disabled={running}
          style={{ ...segBtn(T, false), padding: '4px 12px', color: running ? T.muted : T.text, fontStyle: 'italic' }}
        >
          nudibranch
        </button>
        <label style={{ ...segBtn(T, false), padding: '4px 12px', cursor: 'pointer', color: T.text }}>
          image
          <input
            type="file" accept="image/*" style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) { loadImage(URL.createObjectURL(file)) }
              e.target.value = ''
            }}
          />
        </label>
      </div>


      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '32px' }}>

        {/* Palette + edge arrows */}
        <div>
          <div style={{ fontSize: '9px', color: T.muted, letterSpacing: '0.1em', marginBottom: '6px' }}>
            PALETTE
          </div>

          {/* Palette canvas with edge hotspots */}
          {(() => {
            const hAutoId = (cfg.left === 'pinched' && cfg.right === 'pinched' && (cfg.top === 'pinched' || cfg.bottom === 'pinched'))
                         || (cfg.left === 'pinched' && cfg.right === 'pinched' && cfg.vJoin === 'twist')
            const vAutoId = (cfg.top  === 'pinched' && cfg.bottom === 'pinched' && (cfg.left === 'pinched' || cfg.right === 'pinched'))
                         || (cfg.top  === 'pinched' && cfg.bottom === 'pinched' && cfg.hJoin === 'twist')
            const autoJoined = (edge: keyof Arrows) =>
              (edge === 'left' || edge === 'right') ? hAutoId : vAutoId

            // Speculatively apply the drag's snapped arrow to get preview arrows for other edges
            const previewArrows: Arrows | null = (() => {
              if (!dragState) return null
              const { edge, snapped } = dragState
              // If the dragged edge is forced-joined and snapped is inward/outward, commit clears to neutral
              const draggedForced = autoJoined(edge)
              if (draggedForced && (snapped === INWARD[edge] || snapped === OUTWARD[edge])) {
                return { ...arrows, [edge]: 'none' }
              }
              return setArrow(arrows, edge, snapped)
            })()
            const previewCfg = previewArrows ? arrowsToCfg(previewArrows) : null

            const HOTSPOT_R = 26  // radius px
            const HOTSPOT_POS: Record<keyof Arrows, { top?: string; bottom?: string; left?: string; right?: string; transform: string }> = {
              top:    { top: '0px',    left: '50%', transform: 'translate(-50%, -50%)' },
              bottom: { bottom: '0px', left: '50%', transform: 'translate(-50%, 50%)' },
              left:   { left: '0px',   top: '50%',  transform: 'translate(-50%, -50%)' },
              right:  { right: '0px',  top: '50%',  transform: 'translate(50%, -50%)' },
            }

            const EdgeHotspot = ({ edge }: { edge: keyof Arrows }) => {
              const committed = arrows[edge]
              const isDragging = dragState?.edge === edge

              // What this edge would show after commit (preview for non-dragged edges)
              const preview = previewArrows ? previewArrows[edge] : committed
              const isGhost = !isDragging && previewArrows !== null && preview !== committed

              // Forced-join: this axis is auto-joined
              const forced = autoJoined(edge)
              // For forced-join, derive from preview cfg (or committed cfg if no drag)
              const pc = previewCfg ?? cfg
              const displayForced = (edge === 'left' || edge === 'right')
                ? (pc.left === 'pinched' && pc.right === 'pinched' && (pc.top === 'pinched' || pc.bottom === 'pinched' || pc.vJoin === 'twist'))
                : (pc.top === 'pinched' && pc.bottom === 'pinched' && (pc.left === 'pinched' || pc.right === 'pinched' || pc.hJoin === 'twist'))

              // Glyph to display
              // Forced-join: show ↕ or ↔
              // Dragging: show snapped arrow
              // Ghost (forced by drag): show preview arrow
              // Normal: show committed arrow
              let glyph: string
              if (displayForced) {
                glyph = (edge === 'left' || edge === 'right') ? '↔' : '↕'
              } else if (isDragging) {
                glyph = ARROW_GLYPH[dragState!.snapped]
              } else {
                glyph = ARROW_GLYPH[preview]
              }

              const isActive = displayForced || preview !== 'none'

              // Colors
              const color = isDragging ? '#bdb' : isGhost ? '#7a9' : isActive ? '#8d8' : '#333'
              const bg    = isDragging ? '#1e2e1e' : isGhost ? '#1a2520' : isActive ? '#1a2a1a' : '#161616'
              const border = isDragging ? '#5a8a5a' : isGhost ? '#3a6050' : isActive ? '#3a5a3a' : '#2a2a2a'

              const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                const cx = rect.left + rect.width / 2
                const cy = rect.top + rect.height / 2
                const ds = { edge, snapped: committed, dx: 0, dy: 0, cx, cy }
                dragRef.current = ds
                setDragState(ds)
              }

              const R = HOTSPOT_R
              const lineLen = isDragging ? Math.min(Math.sqrt(dragState!.dx**2 + dragState!.dy**2), R * 2.5) : 0
              const lineAngle = isDragging ? Math.atan2(dragState!.dy, dragState!.dx) : 0
              const lx = isDragging ? Math.cos(lineAngle) * lineLen : 0
              const ly = isDragging ? Math.sin(lineAngle) * lineLen : 0

              return (
                <svg
                  width={R * 2} height={R * 2}
                  viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`}
                  style={{
                    position: 'absolute',
                    cursor: 'crosshair',
                    overflow: 'visible',
                    ...HOTSPOT_POS[edge],
                    zIndex: isDragging ? 10 : 1,
                  }}
                  onPointerDown={onPointerDown}
                >
                  {/* Drag line */}
                  {isDragging && lineLen > 0 && (
                    <line x1={0} y1={0} x2={lx} y2={ly} stroke="#5a8a5a" strokeWidth={1.5} strokeLinecap="round" />
                  )}
                  {/* Circle */}
                  <circle cx={0} cy={0} r={R - 1} fill={bg} stroke={border} strokeWidth={isGhost ? 1 : 1} strokeDasharray={isGhost ? '2 2' : undefined} />
                  {/* Glyph */}
                  {glyph === '·'
                    ? <circle cx={0} cy={0} r={3} fill={color} style={{ pointerEvents: 'none' }} />
                    : <text x={0} y={-4} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={48} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        {glyph}
                      </text>
                  }
                </svg>
              )
            }

            return (
              <div style={{ position: 'relative', width: DISPLAY, height: DISPLAY }}>
                <canvas ref={paletteCanvasRef} width={cols} height={rows}
                  style={{ display: 'block', width: DISPLAY, height: DISPLAY, imageRendering: 'pixelated' }} />
                {/* Iteration drag handle — top right corner */}
                {(() => {
                  const R = 26
                  const bg = iterDragging ? '#1e2e1e' : '#161616'
                  const border = iterDragging ? '#5a8a5a' : '#2a2a2a'
                  const color = iterDragging ? '#bdb' : '#555'
                  const label = iterations >= 1000 ? `${(iterations/1000).toFixed(iterations >= 10000 ? 0 : 1)}k` : String(iterations)
                  return (
                    <svg
                      width={R * 2} height={R * 2}
                      viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`}
                      style={{
                        position: 'absolute', top: 0, left: 0,
                        transform: 'translate(-50%, -50%)',
                        cursor: 'nesw-resize',
                        overflow: 'visible',
                        zIndex: 1,
                      }}
                      onPointerDown={e => {
                        e.stopPropagation()
                        const baseQuality = Math.log10(iterations) * 2
                        iterDragRef.current = { startX: e.clientX, startY: e.clientY, baseQuality }
                        setIterDragging(true)
                      }}
                    >
                      <circle cx={0} cy={0} r={R - 1} fill={bg} stroke={border} strokeWidth={1} />
                      <text x={0} y={-4} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={9} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        iter
                      </text>
                      <text x={0} y={7} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={9} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        {label}
                      </text>
                    </svg>
                  )
                })()}
                <EdgeHotspot edge="top" />
                <EdgeHotspot edge="bottom" />
                <EdgeHotspot edge="left" />
                <EdgeHotspot edge="right" />
                {/* Export drag handle — top right corner */}
                {(() => {
                  const R = 26
                  const isDragging = exportDragY !== null
                  const dy = exportDragY ?? 0
                  // Item 1: PNG at 30–90px, Item 2: GPL at 90+px
                  const activeItem = dy > 90 ? 1 : dy > 30 ? 0 : -1
                  const ITEMS = ['png', 'gpl']
                  const bg = isDragging ? '#1e2e1e' : '#161616'
                  const border = isDragging ? '#5a8a5a' : '#2a2a2a'
                  const color = isDragging ? '#bdb' : '#555'
                  return (
                    <svg
                      width={R * 2} height={R * 2}
                      viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`}
                      style={{
                        position: 'absolute', top: 0, right: 0,
                        transform: 'translate(50%, -50%)',
                        cursor: 'ns-resize',
                        overflow: 'visible',
                        zIndex: isDragging ? 10 : 1,
                      }}
                      onPointerDown={e => {
                        e.stopPropagation()
                        exportDragRef.current = { startY: e.clientY, dy: 0 }
                        setExportDragY(0)
                      }}
                    >
                      {/* Sliding menu items */}
                      {isDragging && ITEMS.map((label, i) => {
                        const itemY = (i + 1) * 64
                        const isActive = activeItem === i
                        return (
                          <g key={label} transform={`translate(0, ${itemY})`}>
                            <circle cx={0} cy={0} r={R - 1}
                              fill={isActive ? '#1e3e1e' : '#161616'}
                              stroke={isActive ? '#5a8a5a' : '#333'}
                              strokeWidth={1} />
                            <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
                              fill={isActive ? '#bdb' : '#555'} fontSize={9} fontFamily="monospace"
                              style={{ userSelect: 'none', pointerEvents: 'none' }}>
                              {label}
                            </text>
                          </g>
                        )
                      })}
                      {/* Drag line */}
                      {isDragging && dy > 0 && (
                        <line x1={0} y1={0} x2={0} y2={Math.min(dy, 90 + R)} stroke="#5a8a5a" strokeWidth={1.5} strokeLinecap="round" />
                      )}
                      {/* Main circle */}
                      <circle cx={0} cy={0} r={R - 1} fill={bg} stroke={border} strokeWidth={1} />
                      <text x={0} y={0} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={9} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        export
                      </text>
                    </svg>
                  )
                })()}
                {/* Decay drag handle — bottom left corner */}
                {(() => {
                  const R = 26
                  const bg = decayDragging ? '#1e2e1e' : '#161616'
                  const border = decayDragging ? '#5a8a5a' : '#2a2a2a'
                  const color = decayDragging ? '#bdb' : '#555'
                  return (
                    <svg
                      width={R * 2} height={R * 2}
                      viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`}
                      style={{
                        position: 'absolute', bottom: 0, left: 0,
                        transform: 'translate(-50%, 50%)',
                        cursor: 'move',
                        overflow: 'visible',
                        zIndex: 1,
                      }}
                      onPointerDown={e => {
                        e.stopPropagation()
                        decayDragRef.current = { startX: e.clientX, startY: e.clientY, baseBlend: blendDecay, baseRadius: radiusDecay }
                        setDecayDragging(true)
                      }}
                    >
                      <circle cx={0} cy={0} r={R - 1} fill={bg} stroke={border} strokeWidth={1} />
                      <text x={0} y={-4} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={8} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        b{blendDecay.toFixed(1)}
                      </text>
                      <text x={0} y={7} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={8} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        r{radiusDecay.toFixed(1)}
                      </text>
                    </svg>
                  )
                })()}
                {/* Grid size drag handle — bottom right corner */}
                {(() => {
                  const R = 26
                  const isGridDragging = gridDragging
                  const bg = isGridDragging ? '#1e2e1e' : '#161616'
                  const border = isGridDragging ? '#5a8a5a' : '#2a2a2a'
                  const color = isGridDragging ? '#bdb' : '#555'
                  return (
                    <svg
                      width={R * 2} height={R * 2}
                      viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`}
                      style={{
                        position: 'absolute', bottom: 0, right: 0,
                        transform: 'translate(50%, 50%)',
                        cursor: 'nwse-resize',
                        overflow: 'visible',
                        zIndex: 1,
                      }}
                      onPointerDown={e => {
                        e.stopPropagation()
                        gridDragRef.current = { startX: e.clientX, startY: e.clientY, baseRows: rows, baseCols: cols }
                        setGridDragging(true)
                      }}
                    >
                      <circle cx={0} cy={0} r={R - 1} fill={bg} stroke={border} strokeWidth={1} />
                      <text x={0} y={-5} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={9} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        {cols}
                      </text>
                      <text x={0} y={7} textAnchor="middle" dominantBaseline="central"
                        fill={color} fontSize={9} fontFamily="monospace" style={{ userSelect: 'none', pointerEvents: 'none' }}>
                        {rows}
                      </text>
                    </svg>
                  )
                })()}
              </div>
            )
          })()}

          {/* Topology name */}
          <div style={{ marginTop: '14px', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '15px', color: T.text }}>{topology.name}</span>
            <span style={{ fontSize: '9px', color: TIER_COLOR[topology.tier] }}>{topology.tier}</span>
            {running && <span style={{ fontSize: '9px', color: T.muted }}>extracting…</span>}
          </div>
        </div>

        {/* Source + Mesh row */}
        <div style={{ display: 'flex', gap: '40px', alignItems: 'flex-start' }}>

          {/* Source image */}
          <div>
            <div style={{ fontSize: '9px', color: T.muted, letterSpacing: '0.1em', marginBottom: '6px' }}>SOURCE</div>
            <canvas
              ref={imageCanvasRef}
              width={256} height={256}
              style={{ display: 'block', width: 256, height: 256 }}
            />
            {attribution && (
              <div style={{ marginTop: '4px', fontSize: '8px', color: T.muted, width: 256 }}>
                {attribution}
              </div>
            )}
          </div>

          {/* 3D mesh */}
          <div>
            <div style={{ fontSize: '9px', color: T.muted, letterSpacing: '0.1em', marginBottom: '6px' }}>MESH</div>
            <div style={{ width: 256, height: 256, background: T.paletteBg }}>
              <Canvas camera={{ position: [0, 0, 1.2], fov: 45 }} flat gl={{ antialias: true }}>
                <TopoMeshScene
                  topologyKey={topologyKey}
                  cfg={cfg}
                  paletteCanvasRef={paletteCanvasRef}
                  paletteReady={paletteReady}
                  offsetX={offsetX}
                  offsetY={offsetY}
                  flipUV={flipUV}
                  morphT={morphT}
                />
              </Canvas>
            </div>
            <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {([['shape', morphT, setMorphT], ['U', offsetX, setOffsetX], ['V', offsetY, setOffsetY]] as const).map(([label, val, set]) => (
                <div key={label} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <span style={{ fontSize: '9px', color: T.muted, width: '10px' }}>{label}</span>
                  <input
                    type="range" min={0} max={1} step={0.001}
                    value={val}
                    onChange={e => set(parseFloat(e.target.value))}
                    style={{ flex: 1, accentColor: T.accent, width: '200px' }}
                  />
                </div>
              ))}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '2px' }}>
                <span style={{ fontSize: '9px', color: T.muted, width: '10px' }} />
                <button onClick={() => setFlipUV(f => !f)} style={segBtn(T, flipUV)}>flip u↔v</button>
              </div>
            </div>
          </div>

        </div>

      </div>

      <div style={{ marginTop: '32px', fontSize: '9px', color: T.muted }}>
        <a href="/" style={{ color: T.muted, textDecoration: 'none' }}>← extractor</a>
      </div>
    </div>
  )
}
