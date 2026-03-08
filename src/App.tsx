import { useState, useRef, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import ColorCube from './ColorCube'
import { runSOMBatch, renderPalette, smoothPaletteCanvas, toHex } from './som'

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
  blendStart: number
  blendEnd: number
  radiusStart: number
  radiusEnd: number
  tileable: boolean
}

const DEFAULT_PARAMS: Params = {
  rows: 8,
  cols: 8,
  quality: 3,
  blendStart: 0.3,
  blendEnd: 0.3,
  radiusStart: 0.3,
  radiusEnd: 0.3,
  tileable: true,
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [params, setParams]         = useState<Params>(DEFAULT_PARAMS)
  const [running, setRunning]       = useState(false)
  const [progress, setProgress]     = useState(0)
  const [imageData, setImageData]   = useState<ImageData | null>(null)
  const [paletteCopy, setPaletteCopy] = useState<Float32Array | null>(null)
  const [hexColors, setHexColors]   = useState<string[]>([])
  const [copied, setCopied]         = useState<string | null>(null)
  const [dragging, setDragging]     = useState(false)

  const paletteCanvasRef = useRef<HTMLCanvasElement>(null)
  const imageCanvasRef   = useRef<HTMLCanvasElement>(null)
  const paletteRef       = useRef(new Float32Array(64 * 3))
  const iterRef          = useRef(0)
  const totalIterRef     = useRef(0)
  const frameCountRef    = useRef(0)
  const animRef          = useRef<number | null>(null)
  const paramsRef        = useRef(params)

  useEffect(() => { paramsRef.current = params }, [params])

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
    const p = paramsRef.current
    const snap = new Float32Array(paletteRef.current)
    setPaletteCopy(snap)
    setHexColors(
      Array.from({ length: p.rows * p.cols }, (_, i) => toHex(snap, i))
    )
  }, [])

  const startTraining = useCallback(() => {
    const data = imageData
    if (!data) return
    if (animRef.current) cancelAnimationFrame(animRef.current)

    const p = paramsRef.current
    const total = Math.max(1, Math.round(Math.pow(10, p.quality / 2)))
    totalIterRef.current = total
    iterRef.current = 0
    frameCountRef.current = 0
    paletteRef.current = new Float32Array(p.rows * p.cols * 3)
    setRunning(true)
    setProgress(0)
    setHexColors([])
    setPaletteCopy(null)

    // Run ~300 visual updates over the full training
    const batchSize = Math.max(10, Math.ceil(total / 300))

    function tick() {
      const p = paramsRef.current
      const from = iterRef.current
      const to   = Math.min(from + batchSize, totalIterRef.current)

      runSOMBatch(
        paletteRef.current, data as ImageData,
        p.rows, p.cols,
        from, to, totalIterRef.current,
        p.blendStart, p.blendEnd,
        p.radiusStart, p.radiusEnd,
        p.tileable,
      )

      iterRef.current = to
      frameCountRef.current++

      // Always update 2D canvas
      if (paletteCanvasRef.current) {
        renderPalette(paletteCanvasRef.current, paletteRef.current, p.rows, p.cols)
      }

      // Update 3D cube less frequently to keep it smooth
      if (frameCountRef.current % 15 === 0) {
        setPaletteCopy(new Float32Array(paletteRef.current))
      }

      const prog = to / totalIterRef.current
      setProgress(prog)

      if (to < totalIterRef.current) {
        animRef.current = requestAnimationFrame(tick)
      } else {
        animRef.current = null
        setRunning(false)
        const snap = new Float32Array(paletteRef.current)
        setPaletteCopy(snap)
        setHexColors(
          Array.from({ length: p.rows * p.cols }, (_, i) => toHex(snap, i))
        )
      }
    }

    animRef.current = requestAnimationFrame(tick)
  }, [imageData])

  // ─── Actions ───────────────────────────────────────────────────────────────

  const handleSmooth = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const p = paramsRef.current
    smoothPaletteCanvas(canvas, paletteRef.current, p.rows, p.cols, p.tileable)
  }, [])

  const handleExport = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'palette.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [])

  const copyHex = useCallback((hex: string) => {
    navigator.clipboard.writeText(hex).catch(() => {})
    setCopied(hex)
    setTimeout(() => setCopied(null), 1500)
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

  function setParam<K extends keyof Params>(key: K, val: Params[K]) {
    setParams(p => ({ ...p, [key]: val }))
  }

  function Slider({
    label, paramKey, min, max, step, display,
  }: {
    label: string
    paramKey: keyof Params
    min: number; max: number; step: number
    display?: string
  }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
          <span style={{ color: MUTED }}>{label}</span>
          <span style={{ color: TEXT }}>{display ?? (params[paramKey] as number).toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={min} max={max} step={step}
          value={params[paramKey] as number}
          onChange={e => setParam(paramKey, parseFloat(e.target.value) as Params[typeof paramKey])}
          disabled={running}
        />
      </div>
    )
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '16px',
      padding: '24px', minHeight: '100vh',
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

      {/* Three panels */}
      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>

        {/* Source image */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '10px', color: MUTED, letterSpacing: '0.15em' }}>SOURCE IMAGE</span>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ fontSize: '10px', color: MUTED, letterSpacing: '0.15em' }}>PALETTE</span>
          <div style={{
            position: 'relative', borderRadius: '10px', overflow: 'hidden',
            border: `1px solid ${BORDER}`,
            width: CANVAS_SIZE, height: CANVAS_SIZE,
            background: '#050d1a',
          }}>
            <canvas
              ref={paletteCanvasRef}
              width={CANVAS_SIZE}
              height={CANVAS_SIZE}
              style={{ display: 'block' }}
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

        {/* 3D color cube */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: '1 1 340px', minWidth: 300 }}>
          <span style={{ fontSize: '10px', color: MUTED, letterSpacing: '0.15em' }}>COLOR SPACE · RGB</span>
          <div style={{
            borderRadius: '10px', overflow: 'hidden',
            border: `1px solid ${BORDER}`,
            height: CANVAS_SIZE, background: '#030810',
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
          <span style={{ fontSize: '10px', color: MUTED, opacity: 0.5, textAlign: 'center' }}>
            drag to orbit · scroll to zoom
          </span>
        </div>
      </div>

      {/* Controls */}
      <div style={{ background: PANEL, borderRadius: '10px', padding: '20px', border: `1px solid ${BORDER}` }}>

        {/* Grid size */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '18px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11px', color: MUTED }}>GRID</span>
          {([4, 6, 8, 12, 16] as const).map(n => (
            <button
              key={n}
              onClick={() => setParams(p => ({ ...p, rows: n, cols: n }))}
              disabled={running}
              style={btn(params.rows === n && params.cols === n)}
            >
              {n}×{n}
            </button>
          ))}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginLeft: 'auto' }}>
            <span style={{ fontSize: '11px', color: MUTED }}>rows</span>
            <input
              type="number" min={1} max={32}
              value={params.rows}
              disabled={running}
              onChange={e => setParam('rows', Math.max(1, Math.min(32, parseInt(e.target.value) || 1)))}
            />
            <span style={{ fontSize: '11px', color: MUTED }}>cols</span>
            <input
              type="number" min={1} max={32}
              value={params.cols}
              disabled={running}
              onChange={e => setParam('cols', Math.max(1, Math.min(32, parseInt(e.target.value) || 1)))}
            />
          </div>
        </div>

        {/* Sliders */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '14px 28px',
          marginBottom: '20px',
        }}>
          <Slider label="Iterations"    paramKey="quality"      min={0} max={10} step={0.1} display={totalIter.toLocaleString()} />
          <Slider label="Blend Start"   paramKey="blendStart"   min={0} max={1}  step={0.005} />
          <Slider label="Blend End"     paramKey="blendEnd"     min={0} max={1}  step={0.005} />
          <Slider label="Radius Start"  paramKey="radiusStart"  min={0} max={1}  step={0.005} />
          <Slider label="Radius End"    paramKey="radiusEnd"    min={0} max={1}  step={0.005} />
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>

          {/* Mode toggle */}
          <div style={{
            display: 'flex', border: `1px solid ${BORDER}`,
            borderRadius: '6px', overflow: 'hidden',
          }}>
            {(['Traditional', 'Tileable'] as const).map(mode => {
              const active = (mode === 'Tileable') === params.tileable
              return (
                <button
                  key={mode}
                  onClick={() => setParam('tileable', mode === 'Tileable')}
                  disabled={running}
                  style={{
                    padding: '6px 16px', border: 'none',
                    cursor: running ? 'not-allowed' : 'pointer',
                    background: active ? 'rgba(50,100,200,0.25)' : 'transparent',
                    color: active ? ACCENT : MUTED,
                    fontFamily: 'inherit', fontSize: '12px',
                    transition: 'all 0.15s',
                  }}
                >
                  {mode}
                </button>
              )
            })}
          </div>

          <button
            onClick={running ? stopTraining : startTraining}
            disabled={!imageData}
            style={btn(!running, running)}
          >
            {running ? '■ Stop' : '▶ Draw'}
          </button>

          <button onClick={handleSmooth} disabled={running} style={btn()}>
            Smooth
          </button>

          <button onClick={handleExport} disabled={running} style={btn()}>
            Export PNG
          </button>
        </div>
      </div>

      {/* Swatches */}
      {hexColors.length > 0 && (
        <div style={{ background: PANEL, borderRadius: '10px', padding: '16px', border: `1px solid ${BORDER}` }}>
          <span style={{ fontSize: '10px', color: MUTED, letterSpacing: '0.15em' }}>
            SWATCHES · click to copy
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '12px', alignItems: 'center' }}>
            {hexColors.map((hex, i) => (
              <button
                key={i}
                title={hex}
                onClick={() => copyHex(hex)}
                style={{
                  width: 36, height: 36,
                  background: hex,
                  border: `2px solid ${copied === hex ? 'white' : 'transparent'}`,
                  borderRadius: '5px', cursor: 'pointer',
                  transition: 'transform 0.1s, border-color 0.15s',
                }}
                onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.18)')}
                onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
              />
            ))}
            {copied && (
              <span style={{ fontSize: '11px', color: 'rgb(100,200,120)', marginLeft: '8px' }}>
                {copied} copied!
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
