import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { type EdgeConfig, DEFAULT_CONFIG, getTopology, getTopologyKey, gridDistance } from './topology'
import { TOPOLOGY_MESH_BUILDERS } from './meshes'

const DEFAULT_ITERATIONS = 500
const DISPLAY = 288  // palette display size in px
const STRIP = 18     // edge strip width in px

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

// ─── Styles ───────────────────────────────────────────────────────────────────

const TIER_COLOR: Record<string, string> = {
  common:       '#666',
  intermediate: '#7a9cc0',
  exotic:       '#9c7ac0',
}

function edgeColor(state: 'free' | 'collapsed') {
  return state === 'collapsed' ? '#c07840' : '#222'
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
}

function TopoMeshScene({ topologyKey, cfg, paletteCanvasRef, paletteReady }: TopoMeshProps) {
  const meshRef   = useRef<THREE.Mesh>(null)
  const texRef    = useRef<THREE.CanvasTexture | null>(null)

  const geometry = useMemo(() => {
    const builder = TOPOLOGY_MESH_BUILDERS[topologyKey]
    return builder ? builder(cfg) : TOPOLOGY_MESH_BUILDERS['F:F'](cfg)
  }, [topologyKey, cfg])

  // Update texture from palette canvas each frame when ready
  useFrame(() => {
    const canvas = paletteCanvasRef.current
    const mesh   = meshRef.current
    if (!canvas || !mesh || !paletteReady) return
    const mat = mesh.material as THREE.MeshBasicMaterial
    if (!texRef.current || texRef.current.image !== canvas) {
      texRef.current?.dispose()
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      texRef.current = tex
      mat.map = tex
      mat.needsUpdate = true
    } else {
      texRef.current.needsUpdate = true
    }
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
  const [cfg, setCfg]             = useState<EdgeConfig>(DEFAULT_CONFIG)
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
  const imageCanvasRef                  = useRef<HTMLCanvasElement>(null)
  const paletteCanvasRef                = useRef<HTMLCanvasElement>(null)
  const genRef                          = useRef(0)

  const topology    = getTopology(cfg)
  const topologyKey = getTopologyKey(cfg)

  const loadImage = useCallback((src: string) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = imageCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      setImageData(ctx.getImageData(0, 0, canvas.width, canvas.height))
    }
    img.src = src
  }, [])

  // Load default image
  useEffect(() => { loadImage(`${import.meta.env.BASE_URL}default.jpeg`) }, [loadImage])

  // Auto-extract whenever image, config, grid size, or redraw key changes
  useEffect(() => {
    if (!imageData) return
    const gen = ++genRef.current
    const palette = initPalette(imageData, rows, cols)
    const batchSize = Math.max(1, Math.ceil(iterations / 120)) // ~120 frames
    let iter = 0
    let rafId: number
    setRunning(true)
    setPaletteReady(false)

    function tick() {
      if (gen !== genRef.current) return
      const to = Math.min(iter + batchSize, iterations)
      runSOMBatch(palette, imageData!, rows, cols, iter, to, iterations, cfg)
      iter = to
      const canvas = paletteCanvasRef.current
      if (canvas) renderPalette(canvas, palette, rows, cols)
      if (iter < iterations) {
        rafId = requestAnimationFrame(tick)
      } else {
        setRunning(false)
        setPaletteReady(true)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(rafId); ++genRef.current }
  }, [imageData, cfg, rows, cols, iterations, redrawKey])

  // ─── Edge interaction ───────────────────────────────────────────────────────

  const toggleEdge = useCallback((edge: 'top' | 'bottom' | 'left' | 'right') => {
    setCfg(c => {
      const next = { ...c }
      next[edge] = c[edge] === 'free' ? 'collapsed' : 'free'
      // Sync opposite edge if on a connected axis
      if ((edge === 'left' || edge === 'right') && c.hConnect !== 'free')
        next[edge === 'left' ? 'right' : 'left'] = next[edge]
      if ((edge === 'top' || edge === 'bottom') && c.vConnect !== 'free')
        next[edge === 'top' ? 'bottom' : 'top'] = next[edge]
      return next
    })
  }, [])

  const setHConnect = useCallback((h: 'free' | 'wrap' | 'twist') => {
    setCfg(c => ({ ...c, hConnect: h, right: h !== 'free' ? c.left : c.right }))
  }, [])

  const setVConnect = useCallback((v: 'free' | 'wrap' | 'twist') => {
    setCfg(c => ({ ...c, vConnect: v, bottom: v !== 'free' ? c.top : c.bottom }))
  }, [])

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ minHeight: '100vh', background: '#111', color: '#ccc', padding: '24px', fontFamily: 'monospace' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.15em', color: '#444', marginBottom: '16px' }}>
        SOM PALETTE · TOPOLOGY SANDBOX
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '24px' }}>
        {([
          { label: 'ROWS', value: rowsInput, set: setRowsInput, commit: (v: number) => { if (v > 0 && v <= 512) setRows(v) } },
          { label: 'COLS', value: colsInput, set: setColsInput, commit: (v: number) => { if (v > 0 && v <= 512) setCols(v) } },
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
        <label style={{ ...segBtn(false), padding: '4px 12px', cursor: 'pointer', color: '#ccc' }}>
          image
          <input
            type="file" accept="image/*" style={{ display: 'none' }}
            onChange={e => {
              const file = e.target.files?.[0]
              if (file) loadImage(URL.createObjectURL(file))
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
        </div>

        {/* Palette + edge controls */}
        <div>
          <div style={{ fontSize: '9px', color: '#444', letterSpacing: '0.1em', marginBottom: '6px' }}>
            PALETTE
          </div>

          {/* Edge grid: 3×3 CSS grid */}
          <div style={{
            display: 'grid',
            gridTemplateRows:    `${STRIP}px ${DISPLAY}px ${STRIP}px`,
            gridTemplateColumns: `${STRIP}px ${DISPLAY}px ${STRIP}px`,
          }}>
            {/* Corner TL */}
            <div style={{ background: '#1a1a1a' }} />

            {/* Top edge */}
            <div
              onClick={() => toggleEdge('top')}
              title="Click to toggle top edge collapse"
              style={{
                background: edgeColor(cfg.top), cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '7px', color: '#888', letterSpacing: '0.1em',
              }}
            >
              {cfg.top === 'collapsed' ? 'C' : ''}
            </div>

            {/* Corner TR */}
            <div style={{ background: '#1a1a1a' }} />

            {/* Left edge */}
            <div
              onClick={() => toggleEdge('left')}
              title="Click to toggle left edge collapse"
              style={{
                background: edgeColor(cfg.left), cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '7px', color: '#888', writingMode: 'vertical-rl',
              }}
            >
              {cfg.left === 'collapsed' ? 'C' : ''}
            </div>

            {/* Palette canvas */}
            <canvas
              ref={paletteCanvasRef}
              width={cols} height={rows}
              style={{ display: 'block', width: DISPLAY, height: DISPLAY, imageRendering: 'pixelated' }}
            />

            {/* Right edge */}
            <div
              onClick={() => toggleEdge('right')}
              title="Click to toggle right edge collapse"
              style={{
                background: edgeColor(cfg.right), cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '7px', color: '#888', writingMode: 'vertical-rl',
              }}
            >
              {cfg.right === 'collapsed' ? 'C' : ''}
            </div>

            {/* Corner BL */}
            <div style={{ background: '#1a1a1a' }} />

            {/* Bottom edge */}
            <div
              onClick={() => toggleEdge('bottom')}
              title="Click to toggle bottom edge collapse"
              style={{
                background: edgeColor(cfg.bottom), cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '7px', color: '#888', letterSpacing: '0.1em',
              }}
            >
              {cfg.bottom === 'collapsed' ? 'C' : ''}
            </div>

            {/* Corner BR */}
            <div style={{ background: '#1a1a1a' }} />
          </div>

          {/* Connection controls */}
          <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
            <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
              <span style={{ fontSize: '9px', color: '#444', width: '16px' }}>H</span>
              {(['free', 'wrap', 'twist'] as const).map(v => (
                <button key={v} onClick={() => setHConnect(v)} style={segBtn(cfg.hConnect === v)}>{v}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
              <span style={{ fontSize: '9px', color: '#444', width: '16px' }}>V</span>
              {(['free', 'wrap', 'twist'] as const).map(v => (
                <button key={v} onClick={() => setVConnect(v)} style={segBtn(cfg.vConnect === v)}>{v}</button>
              ))}
            </div>
          </div>

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
          <div style={{ width: DISPLAY + STRIP * 2, height: DISPLAY + STRIP * 2, background: '#0d0d0d' }}>
            <Canvas camera={{ position: [0, 0, 1.2], fov: 45 }} gl={{ antialias: true }}>
              <TopoMeshScene
                topologyKey={topologyKey}
                cfg={cfg}
                paletteCanvasRef={paletteCanvasRef}
                paletteReady={paletteReady}
              />
            </Canvas>
          </div>
        </div>

      </div>

      <div style={{ marginTop: '32px', fontSize: '9px', color: '#333' }}>
        <a href="/som-palette/" style={{ color: '#444', textDecoration: 'none' }}>← sandbox</a>
      </div>
    </div>
  )
}
