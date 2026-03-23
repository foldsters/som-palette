import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { type EdgeConfig, DEFAULT_CONFIG, getTopology, getTopologyKey, gridDistance } from './topology'
import { TOPOLOGY_MESH_BUILDERS } from './meshes'
import { GLSOM } from './glSOM'
import { NUDIBRANCHS } from './nudibranchs'

const DEFAULT_ITERATIONS = 500
const DISPLAY = 288  // palette display size in px

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
) {
  const { width, height, data } = imageData
  const totalPx = width * height
  const maxRadius = Math.max(rows, cols) / 2

  for (let iter = fromIter; iter < toIter; iter++) {
    const t      = iter / (totalIter - 1)
    const lr     = 0.5 * Math.exp(-t * 4)
    const sigma  = maxRadius * Math.exp(-t * 4) + 0.5
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
  const vBothPinched = (next.top  === 'up'   || next.top  === 'down') && (next.bottom === 'down' || next.bottom === 'up')
  const hBothPinched = (next.left === 'left' || next.left === 'right') && (next.right === 'right' || next.right === 'left')
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


function segBtn(active: boolean): React.CSSProperties {
  return {
    padding: '3px 10px',
    border: `1px solid ${active ? '#555' : '#2a2a2a'}`,
    borderRadius: '3px',
    background: active ? '#2a2a2a' : 'transparent',
    color: active ? '#ccc' : '#444',
    fontSize: '9px',
    cursor: 'pointer',
    fontFamily: 'monospace',
    letterSpacing: '0.05em',
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
      idx.count = full.length
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
      idx.count = filtered.length
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
  const imageCanvasRef                  = useRef<HTMLCanvasElement>(null)
  const paletteCanvasRef                = useRef<HTMLCanvasElement>(null)
  const genRef                          = useRef(0)
  const glRef                           = useRef<GLSOM | null>(null)

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
        runSOMBatch(palette, imageData!, rows, cols, iter, to, iterations, cfg)
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
  }, [imageData, cfg, rows, cols, iterations, redrawKey, useGPU])

  // ─── Edge interaction ───────────────────────────────────────────────────────


  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', background: '#111', color: '#ccc', padding: '24px', fontFamily: 'monospace' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.15em', color: '#444', marginBottom: '16px' }}>
        SOM PALETTE · TOPOLOGY SANDBOX
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '24px' }}>
        {([
          { label: 'ROWS', value: rowsInput, set: setRowsInput, commit: (v: number) => { if (v > 0) setRows(v) } },
          { label: 'COLS', value: colsInput, set: setColsInput, commit: (v: number) => { if (v > 0) setCols(v) } },
          { label: 'ITER', value: iterInput, set: setIterInput, commit: (v: number) => { if (v > 0 && v <= 100000) setIterations(v) } },
        ]).map(({ label, value, set, commit }) => (
          <div key={label} style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
            <span style={{ fontSize: '9px', color: '#444', letterSpacing: '0.1em' }}>{label}</span>
            <input
              type="text"
              value={value}
              onChange={e => set(e.target.value)}
              onBlur={() => commit(parseInt(value))}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              style={{
                width: '52px', padding: '3px 6px', background: '#1a1a1a',
                border: '1px solid #2a2a2a', borderRadius: '3px',
                color: '#ccc', fontSize: '11px', fontFamily: 'monospace',
              }}
            />
          </div>
        ))}
        <button
          onClick={() => setRedrawKey(k => k + 1)}
          disabled={running}
          style={{ ...segBtn(false), color: running ? '#444' : '#ccc', padding: '4px 12px' }}
        >
          {running ? 'running…' : 'redraw'}
        </button>
        <button
          onClick={() => { setUseGPU(g => !g); setRedrawKey(k => k + 1) }}
          disabled={running}
          style={{ ...segBtn(useGPU), padding: '4px 12px' }}
        >
          {useGPU ? 'gpu' : 'cpu'}
        </button>
        <button
          onClick={loadRandom}
          disabled={running}
          style={{ ...segBtn(false), padding: '4px 12px', color: running ? '#444' : '#ccc', fontStyle: 'italic' }}
        >
          nudibranch
        </button>
        <label style={{ ...segBtn(false), padding: '4px 12px', cursor: 'pointer', color: '#ccc' }}>
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


      <div style={{ display: 'flex', gap: '40px', alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Source image */}
        <div>
          <div style={{ fontSize: '9px', color: '#444', letterSpacing: '0.1em', marginBottom: '6px' }}>SOURCE</div>
          <canvas
            ref={imageCanvasRef}
            width={256} height={256}
            style={{ display: 'block', width: 256, height: 256 }}
          />
          {attribution && (
            <div style={{ marginTop: '4px', fontSize: '8px', color: '#444', width: 256 }}>
              {attribution}
            </div>
          )}
        </div>

        {/* Palette + edge arrows */}
        <div>
          <div style={{ fontSize: '9px', color: '#444', letterSpacing: '0.1em', marginBottom: '6px' }}>
            PALETTE
          </div>

          {/* 3×3 grid: d-pad selectors + canvas */}
          {(() => {
            const S = 52  // d-pad cell size px
            const B = 16  // d-pad button size px

            // D-pad: 3×3 grid with 5 active squares in + pattern
            // For each edge, the 5 arrows it can take, mapped to d-pad positions
            const DPAD_LAYOUT: Record<keyof Arrows, Partial<Record<Arrow, [number, number]>>> = {
              top:    { up: [0,1], left: [1,0], none: [1,1], right: [1,2], down: [2,1] },
              bottom: { up: [0,1], left: [1,0], none: [1,1], right: [1,2], down: [2,1] },
              left:   { up: [0,1], left: [1,0], none: [1,1], right: [1,2], down: [2,1] },
              right:  { up: [0,1], left: [1,0], none: [1,1], right: [1,2], down: [2,1] },
            }

            const hAutoId = (cfg.left === 'pinched' && cfg.right === 'pinched' && (cfg.top === 'pinched' || cfg.bottom === 'pinched'))
                         || (cfg.left === 'pinched' && cfg.right === 'pinched' && cfg.vJoin === 'twist')
            const vAutoId = (cfg.top  === 'pinched' && cfg.bottom === 'pinched' && (cfg.left === 'pinched' || cfg.right === 'pinched'))
                         || (cfg.top  === 'pinched' && cfg.bottom === 'pinched' && cfg.hJoin === 'twist')
            const autoJoined = (edge: keyof Arrows) =>
              (edge === 'left' || edge === 'right') ? hAutoId : vAutoId

            const DPad = ({ edge }: { edge: keyof Arrows }) => {
              const layout = DPAD_LAYOUT[edge]
              const current = arrows[edge]
              // Auto-join: this edge's axis is forced joined by corner adjacency
              const forced = autoJoined(edge)
              const cells: React.ReactNode[] = []
              for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                  const arrow = Object.entries(layout).find(([, pos]) => pos[0] === r && pos[1] === c)?.[0] as Arrow | undefined
                  if (!arrow) {
                    cells.push(<div key={`${r}-${c}`} />)
                  } else {
                    // When forced: both inward and outward are highlighted; clicking either resets to none
                    const isInOut = arrow === INWARD[edge] || arrow === OUTWARD[edge]
                    const active = forced ? isInOut : current === arrow
                    const onClick = forced && isInOut
                      ? () => setArrows(a => setArrow(a, edge, 'none'))
                      : () => setArrows(a => setArrow(a, edge, current === arrow ? 'none' : arrow))
                    cells.push(
                      <div
                        key={`${r}-${c}`}
                        onClick={onClick}
                        style={{
                          width: B, height: B,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer',
                          background: active ? '#2a3a2a' : '#1a1a1a',
                          border: `1px solid ${active ? '#4a6a4a' : '#222'}`,
                          borderRadius: '2px',
                          color: active ? '#8d8' : '#444',
                          fontSize: '9px',
                          userSelect: 'none' as const,
                        }}
                      >
                        {ARROW_GLYPH[arrow === 'none' ? 'none' : arrow]}
                      </div>
                    )
                  }
                }
              }
              return (
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, ${B}px)`, gridTemplateRows: `repeat(3, ${B}px)`, gap: '2px' }}>
                  {cells}
                </div>
              )
            }

            return (
              <div style={{ display: 'grid', gridTemplateColumns: `${S}px ${DISPLAY}px ${S}px`, gridTemplateRows: `${S}px ${DISPLAY}px ${S}px` }}>
                {/* TL corner */}
                <div />
                {/* Top d-pad */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DPad edge="top" />
                </div>
                {/* TR corner */}
                <div />
                {/* Left d-pad */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DPad edge="left" />
                </div>
                {/* Palette canvas */}
                <canvas ref={paletteCanvasRef} width={cols} height={rows}
                  style={{ display: 'block', width: DISPLAY, height: DISPLAY, imageRendering: 'pixelated' }} />
                {/* Right d-pad */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DPad edge="right" />
                </div>
                {/* BL corner */}
                <div />
                {/* Bottom d-pad */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <DPad edge="bottom" />
                </div>
                {/* BR corner */}
                <div />
              </div>
            )
          })()}

          {/* Topology name */}
          <div style={{ marginTop: '14px', display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span style={{ fontSize: '15px', color: '#ccc' }}>{topology.name}</span>
            <span style={{ fontSize: '9px', color: TIER_COLOR[topology.tier] }}>{topology.tier}</span>
            {running && <span style={{ fontSize: '9px', color: '#555' }}>extracting…</span>}
          </div>
        </div>

        {/* 3D mesh */}
        <div>
          <div style={{ fontSize: '9px', color: '#444', letterSpacing: '0.1em', marginBottom: '6px' }}>MESH</div>
          <div style={{ width: DISPLAY, height: DISPLAY, background: '#0d0d0d' }}>
            <Canvas camera={{ position: [0, 0, 1.2], fov: 45 }} gl={{ antialias: true }}>
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
                <span style={{ fontSize: '9px', color: '#444', width: '10px' }}>{label}</span>
                <input
                  type="range" min={0} max={1} step={0.001}
                  value={val}
                  onChange={e => set(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: '#555' }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '2px' }}>
              <span style={{ fontSize: '9px', color: '#444', width: '10px' }} />
              <button onClick={() => setFlipUV(f => !f)} style={segBtn(flipUV)}>flip u↔v</button>
            </div>
          </div>
        </div>

      </div>

      <div style={{ marginTop: '32px', fontSize: '9px', color: '#333' }}>
        <a href="/som-palette/" style={{ color: '#444', textDecoration: 'none' }}>← sandbox</a>
      </div>
    </div>
  )
}
