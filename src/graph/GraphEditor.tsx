import { useState, useRef, useCallback, useEffect, type PointerEvent as ReactPointerEvent } from 'react'
import type { Graph } from './graphSOM'

interface GraphEditorProps {
  graph: Graph
  colors: Float32Array | null
  size: number
  selectedNode: number | null
  showVoronoi: boolean
  onSelectNode: (id: number | null) => void
  onBranchAt: (parentId: number, x: number, y: number) => void
  onDeleteNode: (id: number) => void
  onMoveNode: (id: number, x: number, y: number) => void
  onAddEdge: (a: number, b: number) => void
  onDeleteEdge: (a: number, b: number) => void
  onBatchDelete: (nodeIds: Set<number>, edgeKeys: Set<string>) => void
  onDragStart: (id: number) => void
  onDragEnd: () => void
}

const NODE_R = 24
const HIT_R  = 30
const EDGE_HIT_W = 14

// ─── Geometry helpers for cut mode ──────────────────────────────────────────

function segmentsIntersect(
  p1x: number, p1y: number, p2x: number, p2y: number,
  p3x: number, p3y: number, p4x: number, p4y: number,
): boolean {
  const d1x = p2x - p1x, d1y = p2y - p1y
  const d2x = p4x - p3x, d2y = p4y - p3y
  const cross = d1x * d2y - d1y * d2x
  if (Math.abs(cross) < 1e-10) return false
  const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / cross
  const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / cross
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}

function pointToSegmentDistSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return (px - x1) ** 2 + (py - y1) ** 2
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq))
  const projX = x1 + t * dx, projY = y1 + t * dy
  return (px - projX) ** 2 + (py - projY) ** 2
}

function nodeColor(colors: Float32Array | null, index: number): string {
  if (!colors) return '#444'
  const r = Math.round(colors[index * 3] * 255)
  const g = Math.round(colors[index * 3 + 1] * 255)
  const b = Math.round(colors[index * 3 + 2] * 255)
  return `rgb(${r},${g},${b})`
}

type DragMode =
  | { kind: 'edge'; sourceId: number; mx: number; my: number; hoverId: number | null }
  | { kind: 'move'; id: number; offsetX: number; offsetY: number }
  | { kind: 'pan'; startX: number; startY: number; basePanX: number; basePanY: number }
  | { kind: 'cut'; points: { x: number; y: number }[]; hitNodes: Set<number>; hitEdges: Set<string> }

export default function GraphEditor({
  graph, colors, size, selectedNode,
  onSelectNode, onBranchAt, onDeleteNode, onMoveNode, onAddEdge, onDeleteEdge, onBatchDelete,
  onDragStart, onDragEnd, showVoronoi,
}: GraphEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [modifierHeld, setModifierHeld] = useState(false)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => setModifierHeld(e.shiftKey || e.ctrlKey || e.metaKey)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey) }
  }, [])
  const [zoom, setZoom] = useState(1)
  const dragRef = useRef<DragMode | null>(null)
  const [dragState, setDragState] = useState<DragMode | null>(null)
  const didDrag = useRef(false)
  const suppressClick = useRef(false)

  const toSVG = useCallback((e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    return { x: panX + cx / zoom, y: panY + cy / zoom }
  }, [panX, panY, zoom])

  const hitTestNode = useCallback((sx: number, sy: number, excludeId?: number): number | null => {
    for (const n of graph.nodes) {
      if (n.id === excludeId) continue
      const dx = n.x - sx, dy = n.y - sy
      if (dx * dx + dy * dy <= HIT_R * HIT_R) return n.id
    }
    return null
  }, [graph.nodes])

  // ─── Node pointer down ────────────────────────────────────────────────────

  const startCut = useCallback((e: ReactPointerEvent) => {
    const pt = toSVG(e)
    const d: DragMode = { kind: 'cut', points: [pt], hitNodes: new Set(), hitEdges: new Set() }
    dragRef.current = d
    setDragState(d)
  }, [toSVG])

  const onPointerDownNode = useCallback((e: ReactPointerEvent, id: number) => {
    e.stopPropagation()
    e.preventDefault()
    suppressClick.current = true
    didDrag.current = false

    // Ctrl/Cmd: start cut mode
    if (e.ctrlKey || e.metaKey) {
      startCut(e)
      return
    }

    ;(e.target as Element).setPointerCapture(e.pointerId)
    const pt = toSVG(e)

    if (e.shiftKey) {
      // Shift+drag: extend edge
      const d: DragMode = { kind: 'edge', sourceId: id, mx: pt.x, my: pt.y, hoverId: null }
      dragRef.current = d
      setDragState(d)
    } else {
      // Default drag: move node
      const node = graph.nodes.find(n => n.id === id)
      if (!node) return
      const d: DragMode = { kind: 'move', id, offsetX: pt.x - node.x, offsetY: pt.y - node.y }
      dragRef.current = d
      setDragState(d)
    }
  }, [graph.nodes, toSVG, startCut])

  // ─── Pointer move ─────────────────────────────────────────────────────────

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    const d = dragRef.current
    if (!d) return

    if (d.kind === 'cut') {
      const pt = toSVG(e)
      const prev = d.points[d.points.length - 1]
      // Check new segment against all edges
      for (const [a, b] of graph.edges) {
        const key = a < b ? `${a}-${b}` : `${b}-${a}`
        if (d.hitEdges.has(key)) continue
        const na = graph.nodes.find(n => n.id === a)
        const nb = graph.nodes.find(n => n.id === b)
        if (!na || !nb) continue
        if (segmentsIntersect(prev.x, prev.y, pt.x, pt.y, na.x, na.y, nb.x, nb.y)) {
          d.hitEdges.add(key)
        }
      }
      // Check new segment against all nodes
      for (const n of graph.nodes) {
        if (d.hitNodes.has(n.id)) continue
        if (pointToSegmentDistSq(n.x, n.y, prev.x, prev.y, pt.x, pt.y) < NODE_R * NODE_R) {
          d.hitNodes.add(n.id)
        }
      }
      d.points.push(pt)
      setDragState({ ...d })
    } else if (d.kind === 'move') {
      const pt = toSVG(e)
      if (!didDrag.current) {
        didDrag.current = true
        onDragStart(d.id)
      }
      onMoveNode(d.id, pt.x - d.offsetX, pt.y - d.offsetY)
    } else if (d.kind === 'edge') {
      didDrag.current = true
      const pt = toSVG(e)
      const hoverId = hitTestNode(pt.x, pt.y, d.sourceId)
      const next: DragMode = { ...d, mx: pt.x, my: pt.y, hoverId }
      dragRef.current = next
      setDragState(next)
    } else if (d.kind === 'pan') {
      setPanX(d.basePanX - (e.clientX - d.startX) / zoom)
      setPanY(d.basePanY - (e.clientY - d.startY) / zoom)
    }
  }, [toSVG, onMoveNode, onDragStart, hitTestNode, graph.nodes, graph.edges])

  // ─── Pointer up ───────────────────────────────────────────────────────────

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    const d = dragRef.current
    dragRef.current = null
    setDragState(null)

    if (!d) return

    if (d.kind === 'cut') {
      if (d.hitNodes.size > 0 || d.hitEdges.size > 0) {
        onBatchDelete(d.hitNodes, d.hitEdges)
      }
    } else if (d.kind === 'move') {
      if (didDrag.current) {
        onDragEnd()
      } else {
        onSelectNode(selectedNode === d.id ? null : d.id)
      }
    } else if (d.kind === 'edge') {
      if (!didDrag.current) {
        onSelectNode(selectedNode === d.sourceId ? null : d.sourceId)
      } else {
        const pt = toSVG(e)
        // Cancel if dropped back on the source node
        const sourceNode = graph.nodes.find(n => n.id === d.sourceId)
        const onSource = sourceNode && (pt.x - sourceNode.x) ** 2 + (pt.y - sourceNode.y) ** 2 <= HIT_R * HIT_R
        if (onSource) {
          // cancelled
        } else {
          const targetId = hitTestNode(pt.x, pt.y, d.sourceId)
          if (targetId !== null) {
            onAddEdge(d.sourceId, targetId)
          } else {
            onBranchAt(d.sourceId, pt.x, pt.y)
          }
        }
      }
    } else if (d.kind === 'pan') {
      // nothing to commit
    }
  }, [selectedNode, onSelectNode, onDragEnd, onAddEdge, onBranchAt, onBatchDelete, toSVG, hitTestNode])

  // ─── Background ───────────────────────────────────────────────────────────

  const onPointerDownBg = useCallback((e: ReactPointerEvent) => {
    if (dragRef.current) return
    if (e.ctrlKey || e.metaKey) {
      startCut(e)
      return
    }
    const d: DragMode = { kind: 'pan', startX: e.clientX, startY: e.clientY, basePanX: panX, basePanY: panY }
    dragRef.current = d
    setDragState(d)
  }, [panX, panY, startCut])

  const onClickBackground = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    onSelectNode(null)
  }, [onSelectNode])

  const onClickEdge = useCallback((e: React.MouseEvent, a: number, b: number) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.stopPropagation()
    onDeleteEdge(a, b)
  }, [onDeleteEdge])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.05 : 1 / 1.05
    const newZoom = Math.min(10, Math.max(0.1, zoom * factor))
    // Keep the point under cursor fixed
    setPanX(panX + cx / zoom - cx / newZoom)
    setPanY(panY + cy / zoom - cy / newZoom)
    setZoom(newZoom)
  }, [zoom, panX, panY])

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // ─── Render ───────────────────────────────────────────────────────────────

  const edgeDrag = dragState?.kind === 'edge' && didDrag.current ? dragState : null
  const edgeSource = edgeDrag ? graph.nodes.find(n => n.id === edgeDrag.sourceId) : null
  const cutState = dragState?.kind === 'cut' ? dragState : null

  // ─── Voronoi background ─────────────────────────────────────────────────
  const voronoiRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = voronoiRef.current
    if (!canvas || !showVoronoi || !colors || graph.nodes.length === 0) return
    const ctx = canvas.getContext('2d')!
    const w = canvas.width, h = canvas.height
    const img = ctx.createImageData(w, h)
    const data = img.data
    // Map viewBox to pixel coords
    const vw = size / zoom, vh = size / zoom
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const sx = panX + (px / w) * vw
        const sy = panY + (py / h) * vh
        // Find nearest node
        let minDist = Infinity, nearest = 0
        for (let i = 0; i < graph.nodes.length; i++) {
          const n = graph.nodes[i]
          const dx = n.x - sx, dy = n.y - sy
          const d = dx * dx + dy * dy
          if (d < minDist) { minDist = d; nearest = i }
        }
        const off = (py * w + px) * 4
        data[off]     = Math.round(colors[nearest * 3] * 255)
        data[off + 1] = Math.round(colors[nearest * 3 + 1] * 255)
        data[off + 2] = Math.round(colors[nearest * 3 + 2] * 255)
        data[off + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }, [showVoronoi, colors, graph.nodes, panX, panY, zoom, size])

  return (
    <div style={{ position: 'relative', width: size, height: size, borderRadius: '4px', overflow: 'hidden' }}>
    {showVoronoi && (
      <canvas
        ref={voronoiRef}
        width={size} height={size}
        style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, imageRendering: 'pixelated' }}
      />
    )}
    <svg
      ref={svgRef}
      width={size} height={size}
      viewBox={`${panX} ${panY} ${size / zoom} ${size / zoom}`}
      style={{ position: 'relative', display: 'block', background: showVoronoi ? 'transparent' : '#161616', cursor: dragState?.kind === 'pan' ? 'grabbing' : 'default' }}
      onPointerDown={onPointerDownBg}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onClick={onClickBackground}
      onContextMenu={onContextMenu}
    >
      {/* Edges (hidden in voronoi mode unless modifier held) */}
      {(!showVoronoi || modifierHeld) && graph.edges.map(([a, b], i) => {
        const na = graph.nodes.find(n => n.id === a)
        const nb = graph.nodes.find(n => n.id === b)
        if (!na || !nb) return null
        const edgeKey = a < b ? `${a}-${b}` : `${b}-${a}`
        const isCut = cutState?.hitEdges.has(edgeKey)
        return (
          <g key={`e${i}`}>
            <line
              x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
              stroke="transparent" strokeWidth={EDGE_HIT_W}
              style={{ cursor: 'pointer' }}
              onClick={e => onClickEdge(e, a, b)}
            />
            <line
              x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
              stroke={isCut ? '#a44' : '#333'} strokeWidth={isCut ? 3 : 2}
              style={{ pointerEvents: 'none' }}
            />
          </g>
        )
      })}

      {/* Rubber-band line during edge drag */}
      {edgeSource && edgeDrag && (
        <line
          x1={edgeSource.x} y1={edgeSource.y}
          x2={edgeDrag.mx} y2={edgeDrag.my}
          stroke={edgeDrag.hoverId !== null ? '#8d8' : '#666'}
          strokeWidth={2}
          strokeDasharray={edgeDrag.hoverId !== null ? undefined : '6 4'}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Nodes */}
      {graph.nodes.map((node, index) => {
        const fill = nodeColor(colors, index)
        const selected = node.id === selectedNode
        const isHover = edgeDrag?.hoverId === node.id
        const isCut = cutState?.hitNodes.has(node.id)
        return (
          <g key={node.id}>
            <circle
              cx={node.x} cy={node.y} r={HIT_R}
              fill="transparent"
              style={{ cursor: dragState?.kind === 'move' ? 'grabbing' : 'crosshair' }}
              onPointerDown={e => onPointerDownNode(e, node.id)}
            />
            <circle
              cx={node.x} cy={node.y} r={NODE_R}
              fill={isCut ? '#a44' : fill}
              stroke={isCut ? '#f66' : isHover ? '#8d8' : selected ? '#8d8' : '#555'}
              strokeWidth={isCut ? 3 : isHover ? 3 : selected ? 2.5 : 1}
              style={{ pointerEvents: 'none' }}
            />
          </g>
        )
      })}

      {/* Cut path */}
      {cutState && cutState.points.length > 1 && (
        <polyline
          points={cutState.points.map(p => `${p.x},${p.y}`).join(' ')}
          fill="none" stroke="#f44" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        />
      )}
    </svg>
    </div>
  )
}
