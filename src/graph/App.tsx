import { useState, useRef, useEffect, useCallback } from 'react'
import {
  type Graph,
  createGraph, addNodeAt, removeNode, addEdge, removeEdge, moveNode, batchDelete,
  computeDistanceMatrix, initGraphPalette, runGraphSOMBatch,
} from './graphSOM'
import GraphEditor from './GraphEditor'
import GraphEditor3D from './GraphEditor3D'
import { NUDIBRANCHS } from '../app/nudibranchs'

const DEFAULT_ITERATIONS = 500
const EDITOR_SIZE = 600
const IMG_SIZE = 200

// ─── Force layout constants ─────────────────────────────────────────────────

const REST_LENGTH = 100   // target edge length (px)
const K_SPRING    = 0.08  // edge spring stiffness
const K_REPEL     = 15000 // base repulsion strength
const K_COLOR     = 8000  // extra repulsion from color distance
const K_CENTER    = 0.003 // centering pull
const STEP        = 0.8   // position update step size
const MIN_DIST    = 1     // avoid division by zero

export default function App() {
  const [graph, setGraph]               = useState<Graph>(() => createGraph(EDITOR_SIZE / 2, EDITOR_SIZE / 2))
  const [imageData, setImageData]       = useState<ImageData | null>(null)
  const [iterations, setIterations]     = useState(DEFAULT_ITERATIONS)
  const [blendDecay, setBlendDecay]     = useState(0.5)
  const [radiusDecay, setRadiusDecay]   = useState(0.5)
  const [selectedNode, setSelectedNode] = useState<number | null>(null)
  const [redrawKey, setRedrawKey]       = useState(0)
  const [running, setRunning]           = useState(false)
  const [colors, setColors]             = useState<Float32Array | null>(null)
  const [attribution, setAttribution]   = useState<string | null>(null)
  const [view, setView]                 = useState<'2d' | '3d'>('2d')

  const imageCanvasRef = useRef<HTMLCanvasElement>(null)
  const genRef         = useRef(0)
  const colorsRef      = useRef<Float32Array | null>(null)
  const draggedRef     = useRef<number | null>(null)
  const graphRef       = useRef(graph)
  graphRef.current = graph

  const getStructKey = (g: Graph) => `${g.nodes.map(n => n.id).join(',')};${g.edges.map(([a,b]) => `${a}-${b}`).join(',')}`

  // ─── Image loading ──────────────────────────────────────────────────────────

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
    img.onerror = () => loadRandom()
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

  useEffect(() => { loadImage(`${import.meta.env.BASE_URL}default.jpeg`) }, [loadImage])

  // ─── SOM training loop ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!imageData) return

    const N = graph.nodes.length
    const { matrix, diameter } = computeDistanceMatrix(graph)
    const palette = initGraphPalette(imageData, N)

    const gen = ++genRef.current
    const batchSize = Math.max(1, Math.ceil(iterations / 120))
    let iter = 0
    let rafId: number
    setRunning(true)

    function tick() {
      if (gen !== genRef.current) return
      const to = Math.min(iter + batchSize, iterations)
      runGraphSOMBatch(palette, imageData!, matrix, N, diameter, iter, to, iterations, blendDecay, radiusDecay)

      const snap = new Float32Array(palette)
      colorsRef.current = snap
      setColors(snap)

      iter = to
      if (iter < iterations) {
        rafId = requestAnimationFrame(tick)
      } else {
        setRunning(false)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(rafId); ++genRef.current }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageData, getStructKey(graph), iterations, redrawKey, blendDecay, radiusDecay])

  // ─── Force-directed layout ────────────────────────────────────────────────

  const viewRef = useRef(view)
  viewRef.current = view

  useEffect(() => {
    let rafId: number

    function step() {
      const g = graphRef.current
      const c = colorsRef.current
      const is3D = viewRef.current === '3d'
      const N = g.nodes.length
      if (N < 2) { rafId = requestAnimationFrame(step); return }

      // Accumulate forces per node
      const fx = new Float64Array(N)
      const fy = new Float64Array(N)
      const fz = new Float64Array(N)

      // Build id→index map
      const idToIdx = new Map<number, number>()
      for (let i = 0; i < N; i++) idToIdx.set(g.nodes[i].id, i)

      // Edge springs: attract toward REST_LENGTH
      for (const [a, b] of g.edges) {
        const ai = idToIdx.get(a)
        const bi = idToIdx.get(b)
        if (ai === undefined || bi === undefined) continue
        const na = g.nodes[ai], nb = g.nodes[bi]
        const dx = nb.x - na.x, dy = nb.y - na.y, dz = nb.z - na.z
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), MIN_DIST)
        const force = K_SPRING * (dist - REST_LENGTH)
        const ux = dx / dist, uy = dy / dist, uz = dz / dist
        fx[ai] += force * ux; fy[ai] += force * uy; fz[ai] += force * uz
        fx[bi] -= force * ux; fy[bi] -= force * uy; fz[bi] -= force * uz
      }

      // Color-based repulsion: all pairs
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const ni = g.nodes[i], nj = g.nodes[j]
          const dx = nj.x - ni.x, dy = nj.y - ni.y, dz = nj.z - ni.z
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), MIN_DIST)

          let colorDist = 1.0
          if (c && i * 3 + 2 < c.length && j * 3 + 2 < c.length) {
            const dr = c[i * 3] - c[j * 3]
            const dg = c[i * 3 + 1] - c[j * 3 + 1]
            const db = c[i * 3 + 2] - c[j * 3 + 2]
            colorDist = Math.sqrt(dr * dr + dg * dg + db * db)
          }

          const repel = (K_REPEL + K_COLOR * colorDist) / (dist * dist)
          const ux = dx / dist, uy = dy / dist, uz = dz / dist
          fx[i] -= repel * ux; fy[i] -= repel * uy; fz[i] -= repel * uz
          fx[j] += repel * ux; fy[j] += repel * uy; fz[j] += repel * uz
        }
      }

      // Centering force
      for (let i = 0; i < N; i++) {
        fx[i] += K_CENTER * (EDITOR_SIZE / 2 - g.nodes[i].x)
        fy[i] += K_CENTER * (EDITOR_SIZE / 2 - g.nodes[i].y)
        if (is3D) {
          fz[i] += K_CENTER * (0 - g.nodes[i].z)
        } else {
          // In 2D mode, pull z back toward 0
          fz[i] += 0.1 * (0 - g.nodes[i].z)
        }
      }

      // Apply forces, skip dragged node
      let moved = false
      const dragged = draggedRef.current
      const newNodes = g.nodes.map((n, i) => {
        if (n.id === dragged) return n
        const mx = fx[i] * STEP
        const my = fy[i] * STEP
        const mz = is3D ? fz[i] * STEP : fz[i] * STEP
        if (Math.abs(mx) < 0.01 && Math.abs(my) < 0.01 && Math.abs(mz) < 0.01) return n
        moved = true
        return { ...n, x: n.x + mx, y: n.y + my, z: n.z + mz }
      })

      if (moved) {
        setGraph(prev => {
          if (prev !== graphRef.current) return prev
          return { ...prev, nodes: newNodes }
        })
      }

      rafId = requestAnimationFrame(step)
    }

    rafId = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafId)
  }, [])

  // ─── Graph mutations ────────────────────────────────────────────────────────

  const handleBranchAt = useCallback((parentId: number, x: number, y: number, z = 0) => {
    setGraph(g => addNodeAt(g, parentId, x, y, z))
  }, [])

  const handleDelete = useCallback((nodeId: number) => {
    setGraph(g => removeNode(g, nodeId))
  }, [])

  const handleMove = useCallback((nodeId: number, x: number, y: number, z?: number) => {
    setGraph(g => moveNode(g, nodeId, x, y, z))
  }, [])

  const handleAddEdge = useCallback((a: number, b: number) => {
    setGraph(g => addEdge(g, a, b))
  }, [])

  const handleDeleteEdge = useCallback((a: number, b: number) => {
    setGraph(g => removeEdge(g, a, b))
  }, [])

  const handleBatchDelete = useCallback((nodeIds: Set<number>, edgeKeys: Set<string>) => {
    setGraph(g => batchDelete(g, nodeIds, edgeKeys))
  }, [])

  const handleDragStart = useCallback((id: number) => {
    draggedRef.current = id
  }, [])

  const handleDragEnd = useCallback(() => {
    draggedRef.current = null
  }, [])

  // ─── Export ──────────────────────────────────────────────────────────────────

  const getNodeColors = useCallback(() => {
    const c = colorsRef.current
    if (!c) return []
    return graph.nodes.map((_, i) => ({
      r: Math.round(c[i * 3] * 255),
      g: Math.round(c[i * 3 + 1] * 255),
      b: Math.round(c[i * 3 + 2] * 255),
    }))
  }, [graph.nodes])

  const exportGPL = useCallback(() => {
    const nodeColors = getNodeColors()
    if (nodeColors.length === 0) return
    const lines = ['GIMP Palette', 'Name: SOM Graph Palette', `Columns: ${nodeColors.length}`, '#']
    for (const { r, g, b } of nodeColors) {
      lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\tUntitled`)
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const link = document.createElement('a')
    link.download = 'palette.gpl'
    link.href = URL.createObjectURL(blob)
    link.click()
    URL.revokeObjectURL(link.href)
  }, [getNodeColors])

  const exportPNG = useCallback(() => {
    const nodeColors = getNodeColors()
    if (nodeColors.length === 0) return
    const S = 64  // swatch size
    const canvas = document.createElement('canvas')
    canvas.width = nodeColors.length * S
    canvas.height = S
    const ctx = canvas.getContext('2d')!
    for (let i = 0; i < nodeColors.length; i++) {
      const { r, g, b } = nodeColors[i]
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(i * S, 0, S, S)
    }
    const link = document.createElement('a')
    link.download = 'palette.png'
    link.href = canvas.toDataURL('image/png')
    link.click()
  }, [getNodeColors])

  const exportJSON = useCallback(() => {
    const c = colorsRef.current
    const data = {
      nodes: graph.nodes.map((n, i) => ({
        id: n.id, x: n.x, y: n.y, z: n.z,
        color: c ? [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]] : null,
      })),
      edges: graph.edges,
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.download = 'graph-palette.json'
    link.href = URL.createObjectURL(blob)
    link.click()
    URL.revokeObjectURL(link.href)
  }, [graph])

  const exportSVG = useCallback(() => {
    const c = colorsRef.current
    if (!c || graph.nodes.length === 0) return
    const R = 24  // same as editor node radius
    const PAD = R + 4
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of graph.nodes) {
      if (n.x < minX) minX = n.x
      if (n.y < minY) minY = n.y
      if (n.x > maxX) maxX = n.x
      if (n.y > maxY) maxY = n.y
    }
    const w = maxX - minX + PAD * 2
    const h = maxY - minY + PAD * 2
    const ox = -minX + PAD
    const oy = -minY + PAD

    const lines: string[] = []
    lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`)
    lines.push(`<rect width="100%" height="100%" fill="#161616"/>`)
    // Edges
    for (const [a, b] of graph.edges) {
      const na = graph.nodes.find(n => n.id === a)
      const nb = graph.nodes.find(n => n.id === b)
      if (!na || !nb) continue
      lines.push(`<line x1="${na.x + ox}" y1="${na.y + oy}" x2="${nb.x + ox}" y2="${nb.y + oy}" stroke="#333" stroke-width="2"/>`)
    }
    // Nodes
    graph.nodes.forEach((n, i) => {
      const r = Math.round(c[i * 3] * 255)
      const g = Math.round(c[i * 3 + 1] * 255)
      const b = Math.round(c[i * 3 + 2] * 255)
      lines.push(`<circle cx="${n.x + ox}" cy="${n.y + oy}" r="${R}" fill="rgb(${r},${g},${b})" stroke="#555" stroke-width="1"/>`)
    })
    lines.push('</svg>')

    const blob = new Blob([lines.join('\n')], { type: 'image/svg+xml' })
    const link = document.createElement('a')
    link.download = 'graph-palette.svg'
    link.href = URL.createObjectURL(blob)
    link.click()
    URL.revokeObjectURL(link.href)
  }, [graph])

  // ─── Render ─────────────────────────────────────────────────────────────────

  const btnStyle: React.CSSProperties = {
    background: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: '4px',
    color: '#ccc',
    padding: '4px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '10px',
    letterSpacing: '0.05em',
  }

  return (
    <div style={{ minHeight: '100vh', background: '#111', color: '#ccc', padding: '24px', fontFamily: 'monospace', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.15em', color: '#444', marginBottom: '16px' }}>
        SOM PALETTE · GRAPH
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '24px', justifyContent: 'center' }}>
        <label style={{ fontSize: '9px', color: '#666', display: 'flex', alignItems: 'center', gap: '4px' }}>
          ITER
          <input
            type="number" value={iterations} min={1}
            onChange={e => { const v = parseInt(e.target.value); if (v > 0) setIterations(v) }}
            style={{ width: '60px' }}
          />
        </label>
        <label style={{ fontSize: '9px', color: '#666', display: 'flex', alignItems: 'center', gap: '4px' }}>
          BLEND
          <input type="range" min={0} max={1} step={0.01} value={blendDecay}
            onChange={e => setBlendDecay(parseFloat(e.target.value))}
            style={{ width: '60px' }}
          />
        </label>
        <label style={{ fontSize: '9px', color: '#666', display: 'flex', alignItems: 'center', gap: '4px' }}>
          RADIUS
          <input type="range" min={0} max={1} step={0.01} value={radiusDecay}
            onChange={e => setRadiusDecay(parseFloat(e.target.value))}
            style={{ width: '60px' }}
          />
        </label>
        <button
          onClick={() => setView(v => v === '2d' ? '3d' : '2d')}
          style={{ ...btnStyle, color: '#8d8' }}
        >
          {view}
        </button>
        <button onClick={() => setRedrawKey(k => k + 1)} style={btnStyle}>
          redraw
        </button>
        <button onClick={loadRandom} disabled={running} style={{ ...btnStyle, color: running ? '#444' : '#ccc', fontStyle: 'italic' }}>
          nudibranch
        </button>
        <label style={{ ...btnStyle, cursor: 'pointer' }}>
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
        <span style={{ fontSize: '9px', color: '#333' }}>|</span>
        <button onClick={exportGPL} disabled={!colors} style={btnStyle}>gpl</button>
        <button onClick={exportPNG} disabled={!colors} style={btnStyle}>png</button>
        <button onClick={exportSVG} disabled={!colors} style={btnStyle}>svg</button>
        <button onClick={exportJSON} style={btnStyle}>json</button>
      </div>

      {/* Source image */}
      <div style={{ marginBottom: '16px', textAlign: 'center' }}>
        <div style={{ fontSize: '9px', color: '#444', letterSpacing: '0.1em', marginBottom: '6px' }}>SOURCE</div>
        <canvas
          ref={imageCanvasRef}
          width={IMG_SIZE} height={IMG_SIZE}
          style={{ display: 'block', width: IMG_SIZE, height: IMG_SIZE, borderRadius: '4px' }}
        />
        {attribution && (
          <div style={{ marginTop: '4px', fontSize: '8px', color: '#444', width: IMG_SIZE }}>
            {attribution}
          </div>
        )}
      </div>

      {/* Graph editor */}
      <div>
        <div style={{ fontSize: '9px', color: '#444', letterSpacing: '0.1em', marginBottom: '6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>GRAPH · {graph.nodes.length} nodes · {graph.edges.length} edges</span>
          <span style={{ color: running ? '#595' : '#444' }}>{running ? 'training...' : 'idle'}</span>
        </div>
        {view === '2d' ? (
          <GraphEditor
            graph={graph}
            colors={colors}
            size={EDITOR_SIZE}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onBranchAt={handleBranchAt}
            onDeleteNode={handleDelete}
            onMoveNode={handleMove}
            onAddEdge={handleAddEdge}
            onDeleteEdge={handleDeleteEdge}
            onBatchDelete={handleBatchDelete}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        ) : (
          <GraphEditor3D
            graph={graph}
            colors={colors}
            size={EDITOR_SIZE}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            onBranchAt={handleBranchAt}
            onDeleteNode={handleDelete}
            onMoveNode={handleMove}
            onAddEdge={handleAddEdge}
            onDeleteEdge={handleDeleteEdge}
            onBatchDelete={handleBatchDelete}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          />
        )}
        <div style={{ marginTop: '8px', fontSize: '8px', color: '#333', textAlign: 'center' }}>
          drag to move · shift-drag to extend edge · ctrl-drag to cut{view === '2d' ? ' · drag background to pan · scroll to zoom' : ' · orbit to rotate'}
        </div>
      </div>
    </div>
  )
}
