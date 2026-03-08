import { useState, useRef, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import ColorCube, { TopologyScene } from './ColorCube'
import { runSOMBatch, renderPalette, smoothPaletteCanvas } from './som'
import { GLSOM } from './glSOM'
import { type VizSpace, VIZ_AXES } from './colorSpaces'

// ─── Theme ───────────────────────────────────────────────────────────────────

interface Theme {
  accent: string
  muted: string
  text: string
  panel: string
  border: string
  bg: string
  canvas3d: string
}

const DARK: Theme = {
  accent:   'rgb(50, 100, 200)',
  muted:    'rgb(100, 140, 180)',
  text:     '#A9B7C5',
  panel:    'rgba(8, 18, 36, 0.9)',
  border:   'rgba(50, 100, 200, 0.2)',
  bg:       '#030810',
  canvas3d: '#030810',
}

const LIGHT: Theme = {
  accent:   'rgb(40, 90, 190)',
  muted:    'rgb(60, 110, 160)',
  text:     '#1a2a3a',
  panel:    'rgba(255, 255, 255, 0.82)',
  border:   'rgba(50, 100, 200, 0.28)',
  bg:       '#d8eaf8',
  canvas3d: '#e4f0fa',
}

const CANVAS_SIZE = 400

// ─── Shared button style ─────────────────────────────────────────────────────

function btn(T: Theme, active = false, danger = false): React.CSSProperties {
  return {
    padding: '6px 16px',
    borderRadius: '6px',
    border: `1px solid ${danger ? 'rgb(200,80,80)' : active ? T.accent : T.border}`,
    background: danger
      ? 'rgba(200,80,80,0.15)'
      : active
      ? 'rgba(50,100,200,0.2)'
      : 'transparent',
    color: T.text,
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
  blendDecay: number
  radiusDecay: number
  topology: 'rectangular' | 'cylindrical' | 'toroidal' | 'spherical' | 'projective' | 'mobius' | 'klein'
  gaussian: boolean
  randomInit: boolean
}

const DEFAULT_PARAMS: Params = {
  rows: 8,
  cols: 8,
  quality: 3,
  blendDecay: 0.5,
  radiusDecay: 0.5,
  topology: 'toroidal',
  gaussian: true,
  randomInit: true,
}

// ─── Slider ──────────────────────────────────────────────────────────────────

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  display?: string
  disabled?: boolean
  muted: string
  text: string
  onChange: (val: number) => void
}

function Slider({ label, value, min, max, step, display, disabled, muted, text, onChange }: SliderProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
        <span style={{ color: muted }}>{label}</span>
        <span style={{ color: text }}>{display ?? value.toFixed(2)}</span>
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
  const [params, setParams]           = useState<Params>(DEFAULT_PARAMS)
  const [running, setRunning]         = useState(false)
  const [progress, setProgress]       = useState(0)
  const [imageData, setImageData]     = useState<ImageData | null>(null)
  const [paletteCopy, setPaletteCopy] = useState<Float32Array | null>(null)
  const [dragging, setDragging]       = useState(false)
  const [copiedHex, setCopiedHex]     = useState<string | null>(null)
  const [collapsed, setCollapsed]     = useState(false)
  const [vizSpace, setVizSpace]       = useState<VizSpace>('rgb')
  const [lightMode, setLightMode]     = useState(false)
  const [compress, setCompress]       = useState(false)

  const T = lightMode ? LIGHT : DARK

  const paletteCanvasRef = useRef<HTMLCanvasElement>(null)
  const imageCanvasRef   = useRef<HTMLCanvasElement>(null)
  const paletteRef       = useRef(new Float32Array(64 * 3))
  const iterRef          = useRef(0)
  const totalIterRef     = useRef(0)
  const animRef          = useRef<number | null>(null)
  const paramsRef        = useRef(params)
  const glomRef          = useRef<GLSOM | null>(null)
  const usingGLRef       = useRef(false)

  // Mutable refs passed into the R3F topology scene so useFrame always reads
  // the latest values (plain props can go stale across R3F's separate reconciler).
  const lightModeRef    = useRef(lightMode)
  const topologyRef     = useRef(params.topology)
  const paletteReadyRef = useRef(false)
  const rowsRef         = useRef(params.rows)
  const colsRef         = useRef(params.cols)
  useEffect(() => { lightModeRef.current = lightMode },      [lightMode])
  useEffect(() => { topologyRef.current = params.topology }, [params.topology])
  useEffect(() => { rowsRef.current = params.rows },         [params.rows])
  useEffect(() => { colsRef.current = params.cols },         [params.cols])
  // True while training or after completion; reset to false only on palette reset.
  useEffect(() => { if (running) paletteReadyRef.current = true }, [running])

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
    paletteReadyRef.current = false
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
      const scale = Math.max(CANVAS_SIZE / img.width, CANVAS_SIZE / img.height)
      const w = img.width * scale
      const h = img.height * scale
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
      ctx.drawImage(img, (CANVAS_SIZE - w) / 2, (CANVAS_SIZE - h) / 2, w, h)
      const data = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE)
      setImageData(data)
      // Reset palette
      if (animRef.current) { cancelAnimationFrame(animRef.current); animRef.current = null; setRunning(false) }
      const { rows, cols } = paramsRef.current
      const glsom = glomRef.current
      if (glsom) { glsom.init(rows, cols); paletteRef.current = glsom.cpuMirror }
      else { paletteRef.current = new Float32Array(rows * cols * 3) }
      const pc = paletteCanvasRef.current
      if (pc) { const pctx = pc.getContext('2d'); pctx?.clearRect(0, 0, pc.width, pc.height) }
      setProgress(0)
      setPaletteCopy(null)
      paletteReadyRef.current = false
    }
    img.src = src
  }, [])

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

    const glsom = glomRef.current
    if (glsom) {
      glsom.init(p.rows, p.cols)
      paletteRef.current = glsom.cpuMirror
    } else {
      paletteRef.current = new Float32Array(p.rows * p.cols * 3)
    }

    if (p.randomInit) {
      const totalPixels = data.width * data.height
      const palette = paletteRef.current
      for (let i = 0; i < p.rows * p.cols; i++) {
        const pi = Math.floor(Math.random() * totalPixels) * 4
        palette[i * 3]     = data.data[pi]     / 255
        palette[i * 3 + 1] = data.data[pi + 1] / 255
        palette[i * 3 + 2] = data.data[pi + 2] / 255
      }
      if (glsom) glsom.uploadMirror()
    }

    setRunning(true)
    setProgress(0)
    setPaletteCopy(null)

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
      } else {
        runSOMBatch(
          paletteRef.current, data as ImageData,
          p.rows, p.cols,
          from, to, totalIterRef.current,
          p.blendDecay, p.radiusDecay, p.topology, p.gaussian,
        )
      }

      iterRef.current = to

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
    smoothPaletteCanvas(canvas, paletteRef.current, p.rows, p.cols, p.topology === 'toroidal')
  }, [])

  const handleExportPNG = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'palette.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [])

  const handleExportGPL = useCallback(() => {
    const p = paramsRef.current
    const palette = paletteRef.current
    const { rows, cols } = p
    const lines = ['GIMP Palette', 'Name: SOM Palette', `Columns: ${cols}`, '#']
    for (let i = 0; i < rows * cols; i++) {
      const r = palette[i * 3], g = palette[i * 3 + 1], b = palette[i * 3 + 2]
      const ri = Math.round(Math.max(0, Math.min(1, r)) * 255)
      const gi = Math.round(Math.max(0, Math.min(1, g)) * 255)
      const bi = Math.round(Math.max(0, Math.min(1, b)) * 255)
      lines.push(`${ri.toString().padStart(3)} ${gi.toString().padStart(3)} ${bi.toString().padStart(3)}\tUntitled`)
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const link = document.createElement('a')
    link.download = 'palette.gpl'
    link.href = URL.createObjectURL(blob)
    link.click()
    URL.revokeObjectURL(link.href)
  }, [])

  const handlePaletteClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor((e.clientX - rect.left) / rect.width  * canvas.width)
    const y = Math.floor((e.clientY - rect.top)  / rect.height * canvas.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const px = ctx.getImageData(x, y, 1, 1).data
    const hex = `#${px[0].toString(16).padStart(2,'0')}${px[1].toString(16).padStart(2,'0')}${px[2].toString(16).padStart(2,'0')}`
    navigator.clipboard.writeText(hex).then(() => {
      setCopiedHex(hex)
      setTimeout(() => setCopiedHex(null), 1500)
    })
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file?.type.startsWith('image/')) loadFromSrc(URL.createObjectURL(file))
  }, [loadFromSrc])

  // ─── Derived ───────────────────────────────────────────────────────────────

  const totalIter = Math.max(1, Math.round(Math.pow(10, params.quality / 2)))

  function setParam<K extends keyof Params>(key: K, val: Params[K]) {
    setParams(p => ({ ...p, [key]: val }))
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '16px',
      padding: '24px', height: '100vh',
      background: T.bg,
      transition: 'background 0.2s',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ color: T.accent, fontSize: '16px', letterSpacing: '0.12em', fontWeight: 'normal' }}>
            SOM PALETTE EXTRACTOR
          </h1>
          <p style={{ color: T.muted, fontSize: '11px', marginTop: '4px' }}>
            Self-Organizing Map · drop an image to begin
          </p>
        </div>
        <button
          onClick={() => setLightMode(m => !m)}
          style={{ ...btn(T), padding: '5px 12px', marginTop: '2px' }}
          title="Toggle light / dark"
        >
          {lightMode ? '◑ dark' : '◐ light'}
        </button>
      </div>

      {/* Settings pane */}
      <div style={{ background: T.panel, borderRadius: '10px', border: `1px solid ${T.border}`, transition: 'background 0.2s' }}>

        {/* Always-visible row: action buttons + collapse toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button onClick={running ? stopTraining : startTraining} disabled={!imageData} style={btn(T, !running, running)}>
              {running ? '■ Stop' : '▶ Draw'}
            </button>
          </div>
          <button
            onClick={() => setCollapsed(c => !c)}
            style={{ ...btn(T), padding: '4px 10px', fontSize: '14px', lineHeight: 1 }}
          >
            {collapsed ? '▾' : '▴'}
          </button>
        </div>

        {/* Collapsible body */}
        {!collapsed && (
          <div style={{ padding: '0 16px 16px', borderTop: `1px solid ${T.border}` }}>

            {/* Grid size */}
            <div style={{ marginTop: '14px' }}>
              {(['rows', 'cols'] as const).map(axis => (
                <div key={axis} style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', color: T.muted, width: '32px' }}>{axis.toUpperCase()}</span>
                  {[1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].map(n => (
                    <button
                      key={n}
                      onClick={() => setParam(axis, n)}
                      disabled={running}
                      style={{ ...btn(T, params[axis] === n), fontSize: '11px', padding: '4px 10px' }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            {/* Sliders */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '14px 28px',
              marginBottom: '16px',
            }}>
              <Slider label="Iterations" value={params.quality} min={0} max={10} step={0.1} disabled={running} display={totalIter.toLocaleString()} muted={T.muted} text={T.text} onChange={v => setParam('quality', v)} />
              <Slider label="Blend Decay" value={params.blendDecay} min={0} max={1} step={0.01} disabled={running} display={params.blendDecay === 0.5 ? '0.50 (linear)' : params.blendDecay.toFixed(2)} muted={T.muted} text={T.text} onChange={v => setParam('blendDecay', v)} />
              <Slider label="Radius Decay" value={params.radiusDecay} min={0} max={1} step={0.01} disabled={running} display={params.radiusDecay === 0.5 ? '0.50 (linear)' : params.radiusDecay.toFixed(2)} muted={T.muted} text={T.text} onChange={v => setParam('radiusDecay', v)} />
            </div>

            {/* Toggles row */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>

              {/* Mask toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>MASK</span>
                <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderRadius: '6px', overflow: 'hidden' }}>
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
                          color: active ? T.accent : T.muted,
                          fontFamily: 'inherit', fontSize: '12px', transition: 'all 0.15s',
                        }}
                      >
                        {mode}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Init toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>INIT</span>
                <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderRadius: '6px', overflow: 'hidden' }}>
                  {(['Zero', 'Random'] as const).map(mode => {
                    const active = (mode === 'Random') === params.randomInit
                    return (
                      <button
                        key={mode}
                        onClick={() => setParam('randomInit', mode === 'Random')}
                        disabled={running}
                        style={{
                          padding: '6px 16px', border: 'none',
                          cursor: running ? 'not-allowed' : 'pointer',
                          background: active ? 'rgba(50,100,200,0.25)' : 'transparent',
                          color: active ? T.accent : T.muted,
                          fontFamily: 'inherit', fontSize: '12px', transition: 'all 0.15s',
                        }}
                      >
                        {mode}
                      </button>
                    )
                  })}
                </div>
              </div>

            </div>
          </div>
        )}
      </div>

      {/* Image + Palette row */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>

        {/* Source image */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>SOURCE IMAGE</span>
            <label style={{ ...btn(T), cursor: 'pointer' }}>
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
              border: `1px solid ${dragging ? T.accent : T.border}`,
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
                background: 'rgba(0,10,30,0.75)', color: T.accent,
                fontSize: '13px', letterSpacing: '0.1em',
              }}>
                DROP IMAGE
              </div>
            )}
          </div>
        </div>

        {/* Palette canvas */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>PALETTE · click cell to copy hex</span>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={handleSmooth} disabled={running} style={btn(T)}>Smooth</button>
              <button onClick={handleExportPNG} disabled={running} style={btn(T)}>Export PNG</button>
              <button onClick={handleExportGPL} disabled={running} style={btn(T)}>Export GPL</button>
            </div>
          </div>
          <div style={{
            position: 'relative', borderRadius: '10px', overflow: 'hidden',
            border: `1px solid ${T.border}`,
            background: lightMode ? '#c8dff0' : '#050d1a',
          }}>
            <canvas
              ref={paletteCanvasRef}
              width={params.cols}
              height={params.rows}
              style={{
                display: 'block',
                height: CANVAS_SIZE,
                width: `min(${CANVAS_SIZE * params.cols / params.rows}px, 100%)`,
                cursor: 'crosshair',
                imageRendering: 'pixelated',
              }}
              onClick={handlePaletteClick}
            />
            {copiedHex && (
              <div style={{
                position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
                background: lightMode ? 'rgba(220,234,248,0.95)' : 'rgba(0,8,20,0.92)', border: `1px solid ${T.accent}`,
                borderRadius: '6px', padding: '5px 12px',
                display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '12px', color: T.text, pointerEvents: 'none',
              }}>
                <span style={{
                  display: 'inline-block', width: '12px', height: '12px',
                  borderRadius: '2px', background: copiedHex, border: '1px solid rgba(255,255,255,0.2)',
                }} />
                {copiedHex} copied
              </div>
            )}
            {running && (
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                background: lightMode ? 'rgba(220,234,248,0.92)' : 'rgba(0,8,20,0.85)', padding: '8px 12px',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: '10px', color: T.muted, marginBottom: '5px',
                }}>
                  <span>training</span>
                  <span>{Math.round(progress * 100)}%</span>
                </div>
                <div style={{ height: '3px', background: 'rgba(50,100,200,0.2)', borderRadius: '2px' }}>
                  <div style={{
                    height: '100%', width: `${progress * 100}%`,
                    background: T.accent, borderRadius: '2px',
                    transition: 'width 0.05s linear',
                  }} />
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* 3D views */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: '8px' }}>

        {/* RGB cube — always shown */}
        <div style={{
          flex: 1, borderRadius: '10px', overflow: 'hidden',
          border: `1px solid ${T.border}`,
          background: T.canvas3d,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '6px 10px', borderBottom: `1px solid ${T.border}`,
            background: T.panel, flexShrink: 0,
          }}>
            <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>COLOR SPACE</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {(['rgb', 'oklab', 'oklch', 'hsv', 'hsl'] as VizSpace[]).map(space => {
                const [x, y, z] = VIZ_AXES[space]
                const active = vizSpace === space
                return (
                  <button
                    key={space}
                    onClick={() => setVizSpace(space)}
                    style={{
                      padding: '3px 8px', borderRadius: '4px',
                      border: `1px solid ${active ? T.accent : T.border}`,
                      background: active ? 'rgba(50,100,200,0.2)' : 'transparent',
                      color: active ? T.accent : T.muted,
                      fontFamily: 'inherit', fontSize: '10px',
                      cursor: 'pointer', letterSpacing: '0.05em',
                    }}
                    title={`${x} · ${y} · ${z}`}
                  >
                    {space.toUpperCase()}
                  </button>
                )
              })}
              <div style={{ width: '1px', height: '14px', background: T.border, margin: '0 2px' }} />
              <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderRadius: '4px', overflow: 'hidden' }}>
                {([false, true] as const).map(val => {
                  const active = compress === val
                  return (
                    <button
                      key={String(val)}
                      onClick={() => setCompress(val)}
                      style={{
                        padding: '3px 8px', border: 'none',
                        background: active ? 'rgba(50,100,200,0.2)' : 'transparent',
                        color: active ? T.accent : T.muted,
                        fontFamily: 'inherit', fontSize: '10px',
                        cursor: 'pointer', letterSpacing: '0.05em',
                      }}
                    >
                      {val ? 'Compressed' : 'True Color'}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
          <Canvas
            camera={{ position: [1.8, 1.4, 1.8], fov: 45 }}
            style={{ flex: 1 }}
            gl={{ antialias: true }}
          >
            <ColorCube
              imageData={imageData}
              palette={paletteCopy}
              rows={params.rows}
              cols={params.cols}
              vizSpace={vizSpace}
              lightMode={lightMode}
              compress={compress}
            />
          </Canvas>
        </div>

        {/* Topology 3D view — always shown */}
        <div style={{
          flex: 1, borderRadius: '10px', overflow: 'hidden',
          border: `1px solid ${T.border}`,
          background: T.canvas3d,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '6px 10px', borderBottom: `1px solid ${T.border}`,
            background: T.panel, flexShrink: 0,
          }}>
            <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>TOPOLOGY</span>
            <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderRadius: '4px', overflow: 'hidden' }}>
              {([
                ['rectangular', 'Rectangular'], ['cylindrical', 'Cylindrical'],
                ['toroidal', 'Toroidal'], ['spherical', 'Spherical'],
                ['projective', 'Projective'], ['mobius', 'Möbius'], ['klein', 'Klein'],
              ] as const).map(([value, label]) => {
                const active = params.topology === value
                return (
                  <button
                    key={value}
                    onClick={() => setParam('topology', value as Params['topology'])}
                    disabled={running}
                    style={{
                      padding: '3px 8px', border: 'none',
                      cursor: running ? 'not-allowed' : 'pointer',
                      background: active ? 'rgba(50,100,200,0.2)' : 'transparent',
                      color: active ? T.accent : T.muted,
                      fontFamily: 'inherit', fontSize: '10px', transition: 'all 0.15s',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          <Canvas
            camera={{ position: [0, 0, 1.5], fov: 45 }}
            style={{ flex: 1 }}
            gl={{ antialias: true }}
          >
            <TopologyScene
              paletteCanvasRef={paletteCanvasRef}
              lightModeRef={lightModeRef}
              topologyRef={topologyRef}
              paletteReadyRef={paletteReadyRef}
              rowsRef={rowsRef}
              colsRef={colsRef}
            />
          </Canvas>
        </div>

      </div>

    </div>
  )
}
