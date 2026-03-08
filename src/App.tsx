import { useState, useRef, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import ColorCube, { TopologyScene } from './ColorCube'
import { runSOMBatch, renderPalette, smoothPaletteCanvas } from './som'
import { GLSOM } from './glSOM'

// ─── Constants ───────────────────────────────────────────────────────────────

const ACCENT = 'rgb(50, 100, 200)'
const MUTED   = 'rgb(100, 140, 180)'
const TEXT    = '#A9B7C5'
const PANEL   = 'rgba(8, 18, 36, 0.9)'
const BORDER  = 'rgba(50, 100, 200, 0.2)'

const CANVAS_SIZE = 400

// ─── Shared button style ─────────────────────────────────────────────────────

function btn(active = false, danger = false): React.CSSProperties {
  return {
    padding: '6px 16px',
    borderRadius: '6px',
    border: `1px solid ${danger ? 'rgb(200,80,80)' : active ? ACCENT : BORDER}`,
    background: danger
      ? 'rgba(200,80,80,0.15)'
      : active
      ? 'rgba(50,100,200,0.2)'
      : 'transparent',
    color: TEXT,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '12px',
    transition: 'all 0.15s',
    whiteSpace: 'nowrap' as const,
  }
}

// ─── Params ──────────────────────────────────────────────────────────────────

interface Params {
  rows: number
  cols: number
  quality: number
  blendDecay: number  // 0.5 = linear, <0.5 = fast early drop, >0.5 = slow early drop
  radiusDecay: number
  topology: 'traditional' | 'tileable' | 'sphere'
  gaussian: boolean
}

const DEFAULT_PARAMS: Params = {
  rows: 8,
  cols: 8,
  quality: 3,
  blendDecay: 0.5,
  radiusDecay: 0.5,
  topology: 'tileable',
  gaussian: true,
}

// ─── Slider ──────────────────────────────────────────────────────────────────
// Must live outside App so React doesn't remount it on every render.

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  display?: string
  disabled?: boolean
  onChange: (val: number) => void
}

function Slider({ label, value, min, max, step, display, disabled, onChange }: SliderProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
        <span style={{ color: MUTED }}>{label}</span>
        <span style={{ color: TEXT }}>{display ?? value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(parseFloat(e.target.value))}
      />
    </div>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [params, setParams]         = useState<Params>(DEFAULT_PARAMS)
  const [running, setRunning]       = useState(false)
  const [progress, setProgress]     = useState(0)
  const [imageData, setImageData]   = useState<ImageData | null>(null)
  const [paletteCopy, setPaletteCopy] = useState<Float32Array | null>(null)
  const [dragging, setDragging]     = useState(false)

  const paletteCanvasRef = useRef<HTMLCanvasElement>(null)
  const imageCanvasRef   = useRef<HTMLCanvasElement>(null)
  const paletteRef       = useRef(new Float32Array(64 * 3))
  const iterRef          = useRef(0)
  const totalIterRef     = useRef(0)
  const animRef          = useRef<number | null>(null)
  const paramsRef        = useRef(params)
  const glomRef          = useRef<GLSOM | null>(null)
  const usingGLRef       = useRef(false)

  // Init WebGL2 SOM once
  useEffect(() => {
    if (!GLSOM.isSupported()) return
    try {
      glomRef.current = new GLSOM()
      usingGLRef.current = true
      console.log('WebGL2 SOM enabled')
    } catch (e) {
      console.warn('WebGL2 SOM init failed, falling back to CPU:', e)
    }
    return () => { glomRef.current?.dispose(); glomRef.current = null }
  }, [])

  useEffect(() => { paramsRef.current = params }, [params])

  // Reset palette when grid size, topology, or neighbourhood function changes
  useEffect(() => {
    if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null; setRunning(false) }
    const { rows, cols } = params
    const glsom = glomRef.current
    if (glsom) { glsom.init(rows, cols); paletteRef.current = glsom.cpuMirror }
    else { paletteRef.current = new Float32Array(rows * cols * 3) }
    const canvas = paletteCanvasRef.current
    if (canvas) { const ctx = canvas.getContext('2d'); ctx?.clearRect(0, 0, canvas.width, canvas.height) }
    setProgress(0)
    setPaletteCopy(null)
  }, [params.rows, params.cols, params.topology, params.gaussian])

  // ─── Image loading ─────────────────────────────────────────────────────────

  const loadFromSrc = useCallback((src: string) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = imageCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // Cover-fit into CANVAS_SIZE × CANVAS_SIZE
      const scale = Math.max(CANVAS_SIZE / img.width, CANVAS_SIZE / img.height)
      const w = img.width * scale
      const h = img.height * scale
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
      ctx.drawImage(img, (CANVAS_SIZE - w) / 2, (CANVAS_SIZE - h) / 2, w, h)
      const data = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE)
      setImageData(data)
    }
    img.src = src
  }, [])

  // Load default planet image on mount
  useEffect(() => { loadFromSrc('/planet.jpeg') }, [loadFromSrc])

  // ─── Training ──────────────────────────────────────────────────────────────

  const stopTraining = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current)
    animRef.current = null
    setRunning(false)
    setPaletteCopy(new Float32Array(paletteRef.current))
  }, [])

  const startTraining = useCallback(() => {
    const data = imageData
    if (!data) return
    if (animRef.current) cancelAnimationFrame(animRef.current)

    const p = paramsRef.current
    const total = Math.max(1, Math.round(Math.pow(10, p.quality / 2)))
    totalIterRef.current = total
    iterRef.current = 0
    // Init GL or CPU palette buffer
    const glsom = glomRef.current
    if (glsom) {
      glsom.init(p.rows, p.cols)
      paletteRef.current = glsom.cpuMirror
    } else {
      paletteRef.current = new Float32Array(p.rows * p.cols * 3)
    }
    setRunning(true)
    setProgress(0)
    setPaletteCopy(null)

    // Run ~300 visual updates over the full training
    const batchSize = Math.max(10, Math.ceil(total / 300))

    function tick() {
      const p = paramsRef.current
      const from = iterRef.current
      const to   = Math.min(from + batchSize, totalIterRef.current)

      if (glsom) {
        glsom.runBatch(
          data as ImageData,
          from, to, totalIterRef.current,
          p.blendDecay, p.radiusDecay, p.topology, p.gaussian,
        )
        // paletteRef.current already points to glsom.cpuMirror, synced by runBatch
      } else {
        runSOMBatch(
          paletteRef.current, data as ImageData,
          p.rows, p.cols,
          from, to, totalIterRef.current,
          p.blendDecay, p.radiusDecay, p.topology, p.gaussian,
        )
      }

      iterRef.current = to

      // Always update 2D canvas
      if (paletteCanvasRef.current) {
        renderPalette(paletteCanvasRef.current, paletteRef.current, p.rows, p.cols)
      }

      const prog = to / totalIterRef.current
      setProgress(prog)

      if (to < totalIterRef.current) {
        animRef.current = requestAnimationFrame(tick)
      } else {
        animRef.current = null
        setRunning(false)
        setPaletteCopy(new Float32Array(paletteRef.current))
      }
    }

    animRef.current = requestAnimationFrame(tick)
  }, [imageData])

  // ─── Actions ───────────────────────────────────────────────────────────────

  const handleSmooth = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const p = paramsRef.current
    smoothPaletteCanvas(canvas, paletteRef.current, p.rows, p.cols, p.topology === 'tileable')
  }, [])

  const handleExport = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'palette.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file?.type.startsWith('image/')) {
      loadFromSrc(URL.createObjectURL(file))
    }
  }, [loadFromSrc])

  // ─── Derived ───────────────────────────────────────────────────────────────

  const totalIter = Math.max(1, Math.round(Math.pow(10, params.quality / 2)))

  // Palette canvas: 1px per cell, CSS handles display scaling

  function setParam<K extends keyof Params>(key: K, val: Params[K]) {
    setParams(p => ({ ...p, [key]: val }))
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '16px',
      padding: '24px', height: '100vh',
    }}>

      {/* Header */}
      <div>
        <h1 style={{ color: ACCENT, fontSize: '16px', letterSpacing: '0.12em', fontWeight: 'normal' }}>
          SOM PALETTE EXTRACTOR
        </h1>
        <p style={{ color: MUTED, fontSize: '11px', marginTop: '4px' }}>
          Self-Organizing Map · drop an image to begin
        </p>
      </div>

      {/* Image + Palette row */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>

        {/* Source image */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: MUTED, letterSpacing: '0.15em' }}>SOURCE IMAGE</span>
            <label style={{ ...btn(), cursor: 'pointer' }}>
              Upload
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) loadFromSrc(URL.createObjectURL(file))
                  e.target.value = ''
                }}
              />
            </label>
          </div>
          <div
            style={{
              position: 'relative', borderRadius: '10px', overflow: 'hidden',
              border: `1px solid ${dragging ? ACCENT : BORDER}`,
              transition: 'border-color 0.15s', cursor: 'pointer',
              width: CANVAS_SIZE, height: CANVAS_SIZE,
            }}
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
          >
            <canvas ref={imageCanvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} style={{ display: 'block' }} />
            {dragging && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                background: 'rgba(0,10,30,0.75)', color: ACCENT,
                fontSize: '13px', letterSpacing: '0.1em',
              }}>
                DROP IMAGE
              </div>
            )}
          </div>
        </div>

        {/* Palette canvas */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: '10px', color: MUTED, letterSpacing: '0.15em' }}>PALETTE</span>
          <div style={{
            position: 'relative', borderRadius: '10px', overflow: 'hidden',
            border: `1px solid ${BORDER}`,
            background: '#050d1a',
          }}>
            <canvas
              ref={paletteCanvasRef}
              width={params.cols}
              height={params.rows}
              style={{ display: 'block', height: CANVAS_SIZE, width: `min(${CANVAS_SIZE * params.cols / params.rows}px, 100%)` }}
            />
            {running && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: 'rgba(0,8,20,0.85)', padding: '8px 12px',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: '10px', color: MUTED, marginBottom: '5px',
                }}>
                  <span>training</span>
                  <span>{Math.round(progress * 100)}%</span>
                </div>
                <div style={{ height: '3px', background: 'rgba(50,100,200,0.2)', borderRadius: '2px' }}>
                  <div style={{
                    height: '100%', width: `${progress * 100}%`,
                    background: ACCENT, borderRadius: '2px',
                    transition: 'width 0.05s linear',
                  }} />
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 3D views + floating controls */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', gap: '8px', width: '100%', height: '100%' }}>

          {/* RGB cube — always shown */}
          <div style={{
            flex: 1, borderRadius: '10px', overflow: 'hidden',
            border: `1px solid ${BORDER}`, background: '#030810',
          }}>
            <Canvas
              camera={{ position: [1.8, 1.4, 1.8], fov: 45 }}
              style={{ width: '100%', height: '100%' }}
              gl={{ antialias: true }}
            >
              <ColorCube
                imageData={imageData}
                palette={paletteCopy}
                rows={params.rows}
                cols={params.cols}
              />
            </Canvas>
          </div>

          {/* Sphere / Torus — shown for sphere and tileable topologies */}
          {params.topology !== 'traditional' && (
            <div style={{
              flex: 1, borderRadius: '10px', overflow: 'hidden',
              border: `1px solid ${BORDER}`, background: '#030810',
            }}>
              <Canvas
                camera={{ position: [0, 0, 1.5], fov: 45 }}
                style={{ width: '100%', height: '100%' }}
                gl={{ antialias: true }}
              >
                <TopologyScene
                  topology={params.topology}
                  paletteCanvasRef={paletteCanvasRef}
                />
              </Canvas>
            </div>
          )}

        </div>

        {/* Floating controls */}
        <div style={{
          position: 'absolute', top: 12, left: 12,
          background: PANEL, borderRadius: '10px', padding: '16px',
          border: `1px solid ${BORDER}`, backdropFilter: 'blur(8px)',
        }}>

          {/* Grid size */}
          {(['rows', 'cols'] as const).map(axis => (
            <div key={axis} style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', color: MUTED, width: '32px' }}>{axis.toUpperCase()}</span>
              {[1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].map(n => (
                <button
                  key={n}
                  onClick={() => setParam(axis, n)}
                  disabled={running}
                  style={{ ...btn(params[axis] === n), fontSize: '11px', padding: '4px 10px' }}
                >
                  {n}
                </button>
              ))}
            </div>
          ))}

          {/* Sliders */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '14px 28px',
            marginBottom: '16px',
          }}>
            <Slider label="Iterations" value={params.quality} min={0} max={10} step={0.1} disabled={running} display={totalIter.toLocaleString()} onChange={v => setParam('quality', v)} />
            <Slider label="Blend Decay" value={params.blendDecay} min={0} max={1} step={0.01} disabled={running} display={params.blendDecay === 0.5 ? '0.50 (linear)' : params.blendDecay.toFixed(2)} onChange={v => setParam('blendDecay', v)} />
            <Slider label="Radius Decay" value={params.radiusDecay} min={0} max={1} step={0.01} disabled={running} display={params.radiusDecay === 0.5 ? '0.50 (linear)' : params.radiusDecay.toFixed(2)} onChange={v => setParam('radiusDecay', v)} />
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>

            {/* Topology toggle */}
            <div style={{ display: 'flex', border: `1px solid ${BORDER}`, borderRadius: '6px', overflow: 'hidden' }}>
              {(['Traditional', 'Tileable', 'Sphere'] as const).map(mode => {
                const active = params.topology === mode.toLowerCase()
                return (
                  <button
                    key={mode}
                    onClick={() => setParam('topology', mode.toLowerCase() as Params['topology'])}
                    disabled={running}
                    style={{
                      padding: '6px 16px', border: 'none',
                      cursor: running ? 'not-allowed' : 'pointer',
                      background: active ? 'rgba(50,100,200,0.25)' : 'transparent',
                      color: active ? ACCENT : MUTED,
                      fontFamily: 'inherit', fontSize: '12px', transition: 'all 0.15s',
                    }}
                  >
                    {mode}
                  </button>
                )
              })}
            </div>

            {/* Neighbourhood toggle */}
            <div style={{ display: 'flex', border: `1px solid ${BORDER}`, borderRadius: '6px', overflow: 'hidden' }}>
              {(['Hard', 'Gaussian'] as const).map(mode => {
                const active = (mode === 'Gaussian') === params.gaussian
                return (
                  <button
                    key={mode}
                    onClick={() => setParam('gaussian', mode === 'Gaussian')}
                    disabled={running}
                    style={{
                      padding: '6px 16px', border: 'none',
                      cursor: running ? 'not-allowed' : 'pointer',
                      background: active ? 'rgba(50,100,200,0.25)' : 'transparent',
                      color: active ? ACCENT : MUTED,
                      fontFamily: 'inherit', fontSize: '12px', transition: 'all 0.15s',
                    }}
                  >
                    {mode}
                  </button>
                )
              })}
            </div>

            <button onClick={running ? stopTraining : startTraining} disabled={!imageData} style={btn(!running, running)}>
              {running ? '■ Stop' : '▶ Draw'}
            </button>
            <button onClick={handleSmooth} disabled={running} style={btn()}>Smooth</button>
            <button onClick={handleExport} disabled={running} style={btn()}>Export PNG</button>
          </div>
        </div>

        <span style={{ position: 'absolute', bottom: 10, left: 0, right: 0, fontSize: '10px', color: MUTED, opacity: 0.4, textAlign: 'center', pointerEvents: 'none' }}>
          drag to orbit · scroll to zoom · ctrl+drag to pan
        </span>
      </div>

    </div>
  )
}
