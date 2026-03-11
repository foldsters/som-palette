import { useState, useRef, useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import ColorCube, { TopologyScene } from './ColorCube'
import { runSOMBatch, renderPalette } from './som'
import { GLSOM } from './glSOM'
import { type VizSpace, VIZ_AXES } from './colorSpaces'
import { type Theme, deriveTheme, extractPaletteCorners, DANGER, DANGER_BG, DRAG_OVERLAY, MODAL_SCRIM } from './theme'

const CANVAS_SIZE = 400

// ─── Shared button style ─────────────────────────────────────────────────────

function btn(T: Theme, active = false, danger = false): React.CSSProperties {
  return {
    padding: '6px 16px',
    borderRadius: '6px',
    border: `1px solid ${danger ? DANGER : active ? T.accent : T.border}`,
    background: danger
      ? DANGER_BG
      : active
      ? T.border
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
  topology: 'rectangular' | 'cylindrical' | 'toroidal' | 'spherical' | 'projective' | 'mobius' | 'klein' | 'cone' | 'bicone'
  gaussian: boolean
  randomInit: boolean
  maskColor: string | null
  maskTolerance: number
}

const DEFAULT_PARAMS: Params = {
  rows: 8,
  cols: 8,
  quality: 5.4,
  blendDecay: 0.5,
  radiusDecay: 0.5,
  topology: 'rectangular',
  gaussian: true,
  randomInit: true,
  maskColor: null,
  maskTolerance: 0.15,
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
  onRelease?: () => void
}

function Slider({ label, value, min, max, step, display, disabled, muted, text, onChange, onRelease }: SliderProps) {
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
        onPointerUp={onRelease}
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
  const [paletteCopy, setPaletteCopy]       = useState<Float32Array | null>(null)
  const [paletteCorners, setPaletteCorners] = useState<Float32Array | null>(null)
  const [autoRun, setAutoRun]               = useState(false)
  const [dragging, setDragging]       = useState(false)
  const [copiedHex, setCopiedHex]     = useState<string | null>(null)
  const [collapsed, setCollapsed]           = useState(false)
  const [veryNarrow, setVeryNarrow]         = useState(() => window.innerWidth < 400)
  useEffect(() => {
    const handler = () => setVeryNarrow(window.innerWidth < 400)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  const cardMinWidth = veryNarrow ? 250 : 276
  const card3dMinWidth = veryNarrow ? 250 : 280
  const [sourceCollapsed, setSourceCollapsed]         = useState(false)
  const [paletteCollapsed, setPaletteCollapsed]       = useState(false)
  const [colorSpaceCollapsed, setColorSpaceCollapsed] = useState(false)
  const [topologyCollapsed, setTopologyCollapsed]     = useState(false)
  const [vizSpace, setVizSpace]       = useState<VizSpace>('rgb')
  const [lightMode, setLightMode]     = useState(false)
  const [chromaMode, setChromaMode]   = useState(false)
  const [compress, setCompress]       = useState(false)
  const [showGrid, setShowGrid]       = useState(true)
  const [showInfo, setShowInfo]       = useState(false)

  const T = deriveTheme(chromaMode ? paletteCorners : null, lightMode)

  useEffect(() => {
    document.documentElement.style.background = T.bg
    document.body.style.background = T.bg
    document.documentElement.style.setProperty('--accent', T.accent)
    document.documentElement.style.setProperty('--muted', T.muted)
    document.documentElement.style.setProperty('--border', T.border)
    document.documentElement.style.setProperty('--bg', T.bg)
  }, [T.bg, T.accent, T.muted, T.border])

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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowInfo(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
    setPaletteCorners(null)
    paletteReadyRef.current = false
  }, [params.rows, params.cols, params.topology, params.gaussian])

  // ─── Image loading ─────────────────────────────────────────────────────────

  const loadFromSrc = useCallback((src: string, saveToCache = true) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = imageCanvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      // Stretch to fill the full square canvas
      ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
      ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE)
      if (saveToCache) {
        try { localStorage.setItem('som_image', canvas.toDataURL('image/jpeg', 0.85)) } catch {}
      }
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
      setPaletteCorners(null)
      paletteReadyRef.current = false
    }
    img.src = src
  }, [])

  const clearImage = useCallback(() => {
    localStorage.removeItem('som_image')
    const canvas = imageCanvasRef.current
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    const palette = paletteCanvasRef.current
    if (palette) palette.getContext('2d')?.clearRect(0, 0, palette.width, palette.height)
    setImageData(null)
    setPaletteCopy(null)
    setPaletteCorners(null)
    paletteReadyRef.current = false
  }, [])

  useEffect(() => {
    const cached = localStorage.getItem('som_image')
    loadFromSrc(cached ?? `${import.meta.env.BASE_URL}default.jpeg`, !cached)
  }, [loadFromSrc])

  // ─── Training ──────────────────────────────────────────────────────────────

  const stopTraining = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current)
    animRef.current = null
    setRunning(false)
    setPaletteCorners(extractPaletteCorners(paletteRef.current, paramsRef.current.rows, paramsRef.current.cols))
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
      const maskRGB = p.maskColor ? [
        parseInt(p.maskColor.slice(1, 3), 16) / 255,
        parseInt(p.maskColor.slice(3, 5), 16) / 255,
        parseInt(p.maskColor.slice(5, 7), 16) / 255,
      ] as [number, number, number] : null
      const maskTolSq = p.maskTolerance * p.maskTolerance

      if (glsom) {
        glsom.runBatch(
          data as ImageData,
          from, to, totalIterRef.current,
          p.blendDecay, p.radiusDecay, p.topology, p.gaussian,
          maskRGB, maskTolSq,
        )
      } else {
        runSOMBatch(
          paletteRef.current, data as ImageData,
          p.rows, p.cols,
          from, to, totalIterRef.current,
          p.blendDecay, p.radiusDecay, p.topology, p.gaussian,
          maskRGB, maskTolSq,
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
        glomRef.current?.flush()
        animRef.current = null
        setRunning(false)
        setPaletteCorners(extractPaletteCorners(paletteRef.current, p.rows, p.cols))
        setPaletteCopy(new Float32Array(paletteRef.current))
      }
    }

    animRef.current = requestAnimationFrame(tick)
  }, [imageData])

  // Auto-restart when button-style params or image change while autoRun is on.
  // Slider params (quality, blendDecay, radiusDecay) use onBlur instead (see triggerAutoRun).
  useEffect(() => {
    if (!autoRun || !imageData) return
    startTraining()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.rows, params.cols, params.topology, params.gaussian, params.randomInit, params.maskColor, imageData, autoRun])

  const triggerAutoRun = useCallback(() => {
    if (autoRun && imageData) startTraining()
  }, [autoRun, imageData, startTraining])

  // ─── Actions ───────────────────────────────────────────────────────────────

const handleExportPNG = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    link.download = 'palette.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [])

  const handleExportGPL = useCallback(() => {
    const canvas = paletteCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width: cols, height: rows } = canvas
    const px = ctx.getImageData(0, 0, cols, rows).data
    const lines = ['GIMP Palette', 'Name: SOM Palette', `Columns: ${cols}`, '#']
    for (let i = 0; i < rows * cols; i++) {
      const ri = px[i * 4], gi = px[i * 4 + 1], bi = px[i * 4 + 2]
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
    <div style={{ height: '100vh', overflowY: 'auto', background: T.bg, transition: 'background 0.2s' }}>
    <div style={{
      display: 'flex', flexDirection: 'column', gap: '16px',
      padding: '24px', minHeight: '100%',
    }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h1 style={{ color: T.accent, fontSize: '16px', letterSpacing: '0.12em', fontWeight: 'normal' }}>
            SOM PALETTE EXTRACTOR
          </h1>
          <p style={{ color: T.muted, fontSize: '11px', marginTop: '4px' }}>
            Self-Organizing Map · drop an image to begin
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginLeft: 'auto' }}>
          
          <button onClick={() => setLightMode(m => !m)} style={{ ...btn(T), padding: '5px 12px', fontSize: '20px' }} title="Toggle light / dark">
            {lightMode ? '◑' : '◐'}
          </button>
          <button onClick={() => setChromaMode(m => !m)} style={{ ...btn(T, chromaMode), padding: '5px 12px', fontSize: '20px' }} title="Use palette corner colors to tint the UI">
            ✦
          </button>
          <button onClick={() => setShowInfo(true)} style={{ ...btn(T), padding: '5px 12px', fontSize: '20px' }}>?</button>
        </div>
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
            <button onClick={() => setShowInfo(false)} style={{ ...btn(T), position: 'absolute', top: '16px', right: '16px', padding: '3px 10px', fontSize: '14px' }}>✕</button>
            <h2 style={{ color: T.accent, fontSize: '15px', fontWeight: 'normal', letterSpacing: '0.1em', marginBottom: '20px', paddingRight: '40px' }}>
              SOM PALETTE EXTRACTOR
            </h2>

            <p style={{ color: T.muted, marginBottom: '14px' }}>
              A{' '}
              <a href="https://en.wikipedia.org/wiki/Self-organizing_map" target="_blank" rel="noopener noreferrer" style={{ color: T.accent, textDecoration: 'none' }}>
                <strong style={{ color: T.accent }}>Self-Organizing Map (SOM)</strong>
              </a>
              {' '}is an unsupervised neural network
              that performs non-linear dimensionality reduction while preserving the topological structure of its input.
              A grid of nodes — each holding a weight vector in the input space — is trained by repeatedly
              presenting random samples: the closest node (the Best Matching Unit) and its neighbours are nudged
              toward each sample, with influence decaying over both distance and time.
              The result is a low-dimensional map where proximity reflects similarity in the original high-dimensional space.
            </p>
            <p style={{ color: T.muted, marginBottom: '20px' }}>
              Here, each node holds an RGB triplet and the input space is the set of pixel colors in an image.
              Training causes the grid to fold and stretch through color space until it densely covers
              the image's color distribution — brighter regions of the palette correspond to more frequently
              sampled hues. The choice of topology controls how the grid's edges connect,
              letting you extract palettes shaped as toruses, spheres, Möbius bands, and more,
              each producing a different kind of color continuity across the grid.
            </p>

            {[
              ['BASIC USAGE', [
                ['Drop or upload an image', 'Drag onto the source canvas, or use the Upload button.'],
                ['Set grid size', 'Rows × Cols controls how many palette colors are generated.'],
                ['Choose a topology', 'Determines how the grid edges connect (see below).'],
                ['Draw', 'Runs the SOM. Enable Auto to re-run whenever a setting changes.'],
                ['Copy colors', 'Click any cell in the palette to copy its hex value to the clipboard.'],
                ['Export', 'Save the palette as a PNG image or a GIMP-compatible .gpl file.'],
              ]],
              ['PARAMETERS', [
                ['Iterations', 'Number of random pixel samples used to train the palette. More = higher quality, slower.'],
                ['Blend Decay', 'How quickly the learning rate falls off. 0.5 = linear; lower = fast early drop; higher = slow early drop.'],
                ['Radius Decay', 'Same curve applied to the neighbourhood radius — how far each update spreads from the winning cell.'],
                ['Kernel', 'Hard: flat neighbourhood update — all cells within the radius update equally.\nGaussian: smooth falloff — influence decreases toward the radius boundary.'],
                ['Init', 'Zero: all cells start as black.\nRandom: cells are seeded with random pixels sampled from the image.'],
                ['Ignore Color', 'Pixels within tolerance of this color are skipped during sampling — useful for solid backgrounds or transparency.'],
              ]],
              ['TOPOLOGIES', [
                ['Triangle', 'Bottom row collapses to a single point, like a slice through HSV color space.\nGood for palettes anchored to a single dark or neutral tone.'],
                ['Bigon', 'Both top and bottom rows collapse to points, like a slice through HSL color space.\nGood for palettes with distinct dark and light poles and varied hues in between.'],
                ['Rectangle', 'Open grid with no edge connections.\nGeneral-purpose flat palette or swatch grid.'],
                ['Cylinder', 'Left and right edges connect, forming a tube.\nGood for palettes that cycle continuously through hue with no seam.'],
                ['Möbius', 'Left and right edges connect with a half-twist — the surface has only one side.\nGood for palettes where opposite ends of the hue range blend into each other.'],
                ['Klein', 'All edges connect; horizontal edges join with a half-twist. Non-orientable closed surface.\nGood for highly continuous color relationships with no privileged boundary.'],
                ['Torus', 'All edges connect, wrapping in both directions.\nGood for seamlessly tileable texture palettes — both axes loop continuously.'],
                ['Sphere', 'Full spherical surface mapped from the grid.\nGood for normal map palettes, where the layout aligns with the distribution of surface normals.'],
                ['Projective', 'Sphere with antipodal identification — opposite points are treated as the same.\nGood for palettes where complementary colors should share the same region.'],
              ]],
              ['COLOR SPACE VIEWER', [
                ['What it shows', 'Image pixels appear as a point cloud; palette cells appear as larger dots connected by grid lines showing the SOM\'s topology. Lets you see how well the trained palette covers the image\'s color distribution.'],
                ['RGB', 'Linear RGB cube. Axes are red, green, and blue. Best for seeing raw color spread across the full gamut.'],
                ['OKLab', 'Perceptually uniform space. L = lightness, a = green↔red, b = blue↔yellow. Distances reflect perceived color difference, so clusters here are perceptually meaningful.'],
                ['OKLCh', 'Cylindrical form of OKLab. Height = lightness, radius = chroma, angle = hue. Good for seeing how saturated and how varied in hue the palette is.'],
                ['HSV', 'Hue-Saturation-Value cylinder. Height = value, radius = saturation, angle = hue. Desaturated colors cluster on the central axis; dark colors at the bottom.'],
                ['HSL', 'Hue-Saturation-Lightness double cone. Height = lightness, radius = saturation, angle = hue. Both dark and light colors converge on the axis.'],
              ]],
            ].map(([heading, rows]) => (
              <div key={heading as string} style={{ marginBottom: '20px' }}>
                <div style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em', marginBottom: '10px' }}>
                  {heading as string}
                </div>
                {(rows as [string, string][]).map(([term, desc]) => (
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

      {/* Settings pane */}
      <div style={{ background: T.panel, borderRadius: '10px', border: `1px solid ${T.border}`, transition: 'background 0.2s', position: 'sticky', top: 24, zIndex: 10 }}>

        {/* Always-visible row: action buttons + collapse toggle */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button onClick={running ? stopTraining : startTraining} disabled={!imageData} style={btn(T, !running, running)}>
              {running ? '■ Stop' : '▶ Draw'}
            </button>
            <button onClick={() => setAutoRun(a => !a)} disabled={!imageData} style={btn(T, autoRun)}>
              Auto
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
              <Slider label="Iterations" value={params.quality} min={0} max={10} step={0.1} disabled={running} display={totalIter.toLocaleString()} muted={T.muted} text={T.text} onChange={v => setParam('quality', v)} onRelease={triggerAutoRun} />
              <Slider label="Blend Decay" value={params.blendDecay} min={0} max={1} step={0.01} disabled={running} display={params.blendDecay === 0.5 ? '0.50 (linear)' : params.blendDecay.toFixed(2)} muted={T.muted} text={T.text} onChange={v => setParam('blendDecay', v)} onRelease={triggerAutoRun} />
              <Slider label="Radius Decay" value={params.radiusDecay} min={0} max={1} step={0.01} disabled={running} display={params.radiusDecay === 0.5 ? '0.50 (linear)' : params.radiusDecay.toFixed(2)} muted={T.muted} text={T.text} onChange={v => setParam('radiusDecay', v)} onRelease={triggerAutoRun} />
            </div>

            {/* Toggles row */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-start' }}>

              {/* Mask toggle */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>KERNEL</span>
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
                          background: active ? T.border : 'transparent',
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
                          background: active ? T.border : 'transparent',
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

              {/* Ignore color */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>IGNORE COLOR</span>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <label style={{ position: 'relative', cursor: 'pointer', flexShrink: 0 }}>
                    <div style={{
                      width: '32px', height: '32px', borderRadius: '6px',
                      border: `1px solid ${params.maskColor ? T.accent : T.border}`,
                      background: params.maskColor ?? `repeating-conic-gradient(${T.border} 0% 25%, transparent 0% 50%) 0 0 / 8px 8px`,
                    }} />
                    <input
                      type="color"
                      value={params.maskColor ?? '#ffffff'}
                      style={{ position: 'absolute', opacity: 0, inset: 0, width: '100%', height: '100%', cursor: 'pointer' }}
                      onChange={e => setParam('maskColor', e.target.value)}
                    />
                  </label>
                  {params.maskColor && (
                    <button onClick={() => setParam('maskColor', null)} style={{ ...btn(T), padding: '5px 10px' }}>Clear</button>
                  )}
                  {params.maskColor && (
                    <div style={{ width: '120px' }}>
                      <Slider label="Tolerance" value={params.maskTolerance} min={0} max={0.5} step={0.005}
                        display={`${(params.maskTolerance * 100).toFixed(0)}%`}
                        muted={T.muted} text={T.text}
                        onChange={v => setParam('maskTolerance', v)} onRelease={triggerAutoRun} />
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        )}
      </div>

      {/* Image + Palette row */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>

        {/* Source image */}
        <div style={{
          display: 'flex', flexDirection: 'column', flex: 1, minWidth: cardMinWidth, width: '100%', maxWidth: CANVAS_SIZE,
          borderRadius: '10px', overflow: 'hidden',
          border: `1px solid ${dragging ? T.accent : T.border}`,
          transition: 'border-color 0.15s',
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            padding: '10px', borderBottom: sourceCollapsed ? 'none' : `1px solid ${T.border}`,
            background: T.panel, flexShrink: 0,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>SOURCE IMAGE</span>
              <button onClick={() => setSourceCollapsed(c => !c)} style={{ ...btn(T), padding: '4px 10px', fontSize: '14px', lineHeight: 1, flexShrink: 0 }}>
                {sourceCollapsed ? '▾' : '▴'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              {imageData && <button onClick={clearImage} style={btn(T)}>Clear</button>}
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
          </div>
          <div
            style={{ display: sourceCollapsed ? 'none' : 'block', position: 'relative', cursor: 'pointer', width: '100%', aspectRatio: '1', maxHeight: CANVAS_SIZE, background: T.panel, overflow: 'hidden' }}
            onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
          >
            <canvas ref={imageCanvasRef} width={CANVAS_SIZE} height={CANVAS_SIZE} style={{ display: 'block', width: '100%', height: '100%' }} />
            {dragging && (
              <div style={{
                position: 'absolute', inset: 0, display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                background: DRAG_OVERLAY, color: T.accent,
                fontSize: '13px', letterSpacing: '0.1em',
              }}>
                DROP IMAGE
              </div>
            )}
          </div>
        </div>

        {/* Palette canvas */}
        <div style={{
          display: 'flex', flexDirection: 'column', flex: 1, minWidth: cardMinWidth, width: '100%',
          borderRadius: '10px', overflow: 'hidden',
          border: `1px solid ${T.border}`,
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            padding: '10px', borderBottom: paletteCollapsed ? 'none' : `1px solid ${T.border}`,
            background: T.panel, flexShrink: 0,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>PALETTE · click cell to copy hex</span>
              <button onClick={() => setPaletteCollapsed(c => !c)} style={{ ...btn(T), padding: '4px 10px', fontSize: '14px', lineHeight: 1, flexShrink: 0 }}>
                {paletteCollapsed ? '▾' : '▴'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button onClick={handleExportPNG} disabled={running} style={btn(T)}>Export PNG</button>
              <button onClick={handleExportGPL} disabled={running} style={btn(T)}>Export GPL</button>
            </div>
          </div>
          <div style={{ display: paletteCollapsed ? 'none' : 'block', position: 'relative', background: T.paletteBg }}>
            <canvas
              ref={paletteCanvasRef}
              width={params.cols}
              height={params.rows}
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                maxHeight: CANVAS_SIZE,
                cursor: 'crosshair',
                imageRendering: 'pixelated',
              }}
              onClick={handlePaletteClick}
            />
            {copiedHex && (
              <div style={{
                position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
                background: T.overlayBg, border: `1px solid ${T.accent}`,
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
                background: T.overlayBg, padding: '8px 12px',
              }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between',
                  fontSize: '10px', color: T.muted, marginBottom: '5px',
                }}>
                  <span>training</span>
                  <span>{Math.round(progress * 100)}%</span>
                </div>
                <div style={{ height: '3px', background: T.border, borderRadius: '2px' }}>
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
      <div style={{ flex: 1, minHeight: CANVAS_SIZE, display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-start', alignContent: 'flex-start' }}>

        {/* RGB cube — always shown */}
        <div style={{
          flex: 1, minWidth: card3dMinWidth, minHeight: colorSpaceCollapsed ? 0 : CANVAS_SIZE, borderRadius: '10px', overflow: 'hidden',
          border: `1px solid ${T.border}`,
          background: T.canvas3d,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            padding: '10px', borderBottom: colorSpaceCollapsed ? 'none' : `1px solid ${T.border}`,
            background: T.panel, flexShrink: 0, minHeight: 96,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>COLOR SPACE</span>
              <button
                onClick={() => setColorSpaceCollapsed(c => !c)}
                style={{ ...btn(T), padding: '4px 10px', fontSize: '14px', lineHeight: 1, flexShrink: 0 }}
              >
                {colorSpaceCollapsed ? '▾' : '▴'}
              </button>
            </div>
            <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderRadius: '4px', overflow: 'hidden', alignSelf: 'flex-start' }}>
                  {(['rgb', 'oklab', 'oklch', 'hsv', 'hsl'] as VizSpace[]).map(space => {
                    const [x, y, z] = VIZ_AXES[space]
                    const active = vizSpace === space
                    return (
                      <button
                        key={space}
                        onClick={() => setVizSpace(space)}
                        style={{
                          padding: '3px 8px', border: 'none',
                          background: active ? T.border : 'transparent',
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
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', alignSelf: 'flex-start' }}>
              <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderRadius: '4px', overflow: 'hidden' }}>
                {([false, true] as const).map(val => {
                  const active = compress === val
                  return (
                    <button
                      key={String(val)}
                      onClick={() => setCompress(val)}
                      style={{
                        padding: '3px 8px', border: 'none',
                        background: active ? T.border : 'transparent',
                        color: active ? T.accent : T.muted,
                        fontFamily: 'inherit', fontSize: '10px',
                        cursor: 'pointer', letterSpacing: '0.05em',
                      }}
                    >
                      {val ? 'Contrast' : 'True Color'}
                    </button>
                  )
                })}
              </div>
              <button
                onClick={() => setShowGrid(g => !g)}
                style={{
                  padding: '3px 8px', border: `1px solid ${T.border}`, borderRadius: '4px',
                  background: showGrid ? T.border : 'transparent',
                  color: showGrid ? T.accent : T.muted,
                  fontFamily: 'inherit', fontSize: '10px',
                  cursor: 'pointer', letterSpacing: '0.05em',
                }}
              >
                Grid
              </button>
            </div>
          </div>
          {!colorSpaceCollapsed && <Canvas
            camera={{ position: [1.8, 1.4, 1.8], fov: 45 }}
            style={{ height: CANVAS_SIZE }}
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
              topology={params.topology}
              showGrid={showGrid}
            />
          </Canvas>}
        </div>

        {/* Topology 3D view — always shown */}
        <div style={{
          flex: 1, minWidth: card3dMinWidth, minHeight: topologyCollapsed ? 0 : CANVAS_SIZE, borderRadius: '10px', overflow: 'hidden',
          border: `1px solid ${T.border}`,
          background: T.canvas3d,
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', flexDirection: 'column', gap: '6px',
            padding: '10px', borderBottom: topologyCollapsed ? 'none' : `1px solid ${T.border}`,
            background: T.panel, flexShrink: 0, minHeight: 96,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '10px', color: T.muted, letterSpacing: '0.15em' }}>TOPOLOGY</span>
              <button
                onClick={() => setTopologyCollapsed(c => !c)}
                style={{ ...btn(T), padding: '4px 10px', fontSize: '14px', lineHeight: 1, flexShrink: 0 }}
              >
                {topologyCollapsed ? '▾' : '▴'}
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', border: `1px solid ${T.border}`, borderRadius: '4px', overflow: 'hidden', alignSelf: 'flex-start' }}>
              {([
                ['cone', 'Triangle'],
                ['bicone', 'Bigon'],
                ['rectangular', 'Rectangle'],
                ['cylindrical', 'Cylinder'],
                ['mobius', 'Möbius'],
                ['klein', 'Klein'],
                ['toroidal', 'Torus'],
                ['spherical', 'Sphere'],
                ['projective', 'Projective'],
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
                      background: active ? T.border : 'transparent',
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
          {!topologyCollapsed && <Canvas
            camera={{ position: [0, 0, 1.5], fov: 45 }}
            style={{ height: CANVAS_SIZE }}
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
          </Canvas>}
        </div>

      </div>

    </div>

    <div style={{ height: '30vh' }} />

    </div>
  )
}
