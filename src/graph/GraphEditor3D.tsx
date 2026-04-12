import { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Graph } from './graphSOM'

interface GraphEditor3DProps {
  graph: Graph
  colors: Float32Array | null
  size: number
  selectedNode: number | null
  onSelectNode: (id: number | null) => void
  onBranchAt: (parentId: number, x: number, y: number, z: number) => void
  onDeleteNode: (id: number) => void
  onMoveNode: (id: number, x: number, y: number, z: number) => void
  onAddEdge: (a: number, b: number) => void
  onDeleteEdge: (a: number, b: number) => void
  onBatchDelete: (nodeIds: Set<number>, edgeKeys: Set<string>) => void
  onDragStart: (id: number) => void
  onDragEnd: () => void
}

const NODE_R = 16
const HIT_R = 20

function nodeColor(colors: Float32Array | null, index: number): THREE.Color {
  const c = new THREE.Color()
  if (!colors) return c.setRGB(0.25, 0.25, 0.25, THREE.SRGBColorSpace)
  return c.setRGB(colors[index * 3], colors[index * 3 + 1], colors[index * 3 + 2], THREE.SRGBColorSpace)
}

// ─── Inner scene component (has access to useThree) ─────────────────────────

type DragMode3D =
  | { kind: 'edge'; sourceId: number; plane: THREE.Plane }
  | { kind: 'move'; id: number; plane: THREE.Plane; offset: THREE.Vector3 }

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

function GraphScene({
  graph, colors, selectedNode, cutHitNodes, cutHitEdges,
  onSelectNode, onBranchAt, onDeleteNode, onMoveNode, onAddEdge, onDeleteEdge,
  onDragStart, onDragEnd, cameraRef,
}: Omit<GraphEditor3DProps, 'size' | 'onBatchDelete'> & { cutHitNodes: Set<number>; cutHitEdges: Set<string>; cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const { camera, raycaster, pointer, gl } = useThree()
  cameraRef.current = camera
  const controlsRef = useRef<any>(null)
  const dragRef = useRef<DragMode3D | null>(null)
  const didDrag = useRef(false)
  const dragStarted = useRef(false)

  // Disable orbit controls while ctrl/meta is held so cut mode works
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Control' || e.key === 'Meta') && controlsRef.current) {
        controlsRef.current.enabled = false
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.key === 'Control' || e.key === 'Meta') && controlsRef.current && !dragRef.current) {
        controlsRef.current.enabled = true
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])
  const [dragPoint, setDragPoint] = useState<THREE.Vector3 | null>(null)
  const [dragSourceId, setDragSourceId] = useState<number | null>(null)
  const [hoverNodeId, setHoverNodeId] = useState<number | null>(null)

  // Stable refs for callbacks used in DOM listener
  const propsRef = useRef({ graph, colors, selectedNode, onSelectNode, onBranchAt, onDeleteNode, onMoveNode, onAddEdge, onDragEnd })
  propsRef.current = { graph, colors, selectedNode, onSelectNode, onBranchAt, onDeleteNode, onMoveNode, onAddEdge, onDragEnd }

  const _intersection = useMemo(() => new THREE.Vector3(), [])

  // Compute graph center for positioning
  const center = useMemo(() => {
    if (graph.nodes.length === 0) return new THREE.Vector3()
    let cx = 0, cy = 0, cz = 0
    for (const n of graph.nodes) { cx += n.x; cy += n.y; cz += n.z }
    return new THREE.Vector3(cx / graph.nodes.length, cy / graph.nodes.length, cz / graph.nodes.length)
  }, [graph.nodes])
  const centerRef = useRef(center)
  centerRef.current = center

  const getPlaneAtNode = useCallback((nodeId: number) => {
    const node = graph.nodes.find(n => n.id === nodeId)
    if (!node) return new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const pos = new THREE.Vector3(node.x - center.x, -(node.y - center.y), node.z)
    const normal = new THREE.Vector3().subVectors(camera.position, pos).normalize()
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pos)
  }, [graph.nodes, center, camera])

  const intersectPlane = useCallback((plane: THREE.Plane): THREE.Vector3 | null => {
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.ray.intersectPlane(plane, _intersection)
    return hit ? hit.clone() : null
  }, [raycaster, pointer, camera, _intersection])

  const hitTestNode = useCallback((excludeId?: number): number | null => {
    raycaster.setFromCamera(pointer, camera)
    let closest: { id: number; dist: number } | null = null
    for (let i = 0; i < graph.nodes.length; i++) {
      const n = graph.nodes[i]
      if (n.id === excludeId) continue
      const pos = new THREE.Vector3(n.x - center.x, -(n.y - center.y), n.z)
      const sphere = new THREE.Sphere(pos, HIT_R)
      const hit = raycaster.ray.intersectSphere(sphere, _intersection)
      if (hit) {
        const dist = hit.distanceTo(camera.position)
        if (!closest || dist < closest.dist) closest = { id: n.id, dist }
      }
    }
    return closest?.id ?? null
  }, [graph.nodes, center, raycaster, pointer, camera, _intersection])
  const hitTestNodeRef = useRef(hitTestNode)
  hitTestNodeRef.current = hitTestNode

  const intersectPlaneRef = useRef(intersectPlane)
  intersectPlaneRef.current = intersectPlane

  // ─── Pointer down on node ─────────────────────────────────────────────────

  const onPointerDown = useCallback((e: any, nodeId: number) => {
    e.stopPropagation()

    if (e.ctrlKey || e.metaKey) {
      if (graph.nodes.length > 1) {
        onDeleteNode(nodeId)
        if (selectedNode === nodeId) onSelectNode(null)
      }
      return
    }

    didDrag.current = false
    dragStarted.current = false
    const plane = getPlaneAtNode(nodeId)

    if (e.shiftKey) {
      // Shift+drag: extend edge
      dragRef.current = { kind: 'edge', sourceId: nodeId, plane }
      setDragSourceId(nodeId)
    } else {
      // Default drag: move node
      const node = graph.nodes.find(n => n.id === nodeId)!
      const nodePos = new THREE.Vector3(node.x - center.x, -(node.y - center.y), node.z)
      const hitPt = intersectPlane(plane)
      const offset = hitPt ? new THREE.Vector3().subVectors(nodePos, hitPt) : new THREE.Vector3()
      dragRef.current = { kind: 'move', id: nodeId, plane, offset }
    }

    if (controlsRef.current) controlsRef.current.enabled = false
  }, [graph.nodes, center, selectedNode, onDeleteNode, onSelectNode, getPlaneAtNode, intersectPlane])

  // ─── Track drag each frame ────────────────────────────────────────────────

  useFrame(() => {
    const d = dragRef.current
    if (!d) return

    if (d.kind === 'move') {
      const hitPt = intersectPlaneRef.current(d.plane)
      if (hitPt) {
        if (!dragStarted.current) {
          dragStarted.current = true
          onDragStart(d.id)
        }
        didDrag.current = true
        const worldPos = hitPt.clone().add(d.offset)
        const c = centerRef.current
        onMoveNode(d.id, worldPos.x + c.x, -(worldPos.y - c.y), worldPos.z)
      }
    } else if (d.kind === 'edge') {
      const hitPt = intersectPlaneRef.current(d.plane)
      if (hitPt) {
        didDrag.current = true
        setDragPoint(hitPt)
        const hover = hitTestNodeRef.current(d.sourceId)
        setHoverNodeId(hover)
      }
    }
  })

  // ─── Global pointer up via DOM ────────────────────────────────────────────

  useEffect(() => {
    const dom = gl.domElement

    const handlePointerUp = () => {
      const d = dragRef.current
      dragRef.current = null
      setDragPoint(null)
      setDragSourceId(null)
      setHoverNodeId(null)

      if (controlsRef.current) controlsRef.current.enabled = true

      if (!d) return

      const { selectedNode, onSelectNode, onDragEnd, onAddEdge, onBranchAt } = propsRef.current
      const c = centerRef.current

      if (d.kind === 'move') {
        if (didDrag.current) onDragEnd()
        else onSelectNode(selectedNode === d.id ? null : d.id)
      } else if (d.kind === 'edge') {
        if (!didDrag.current) {
          onSelectNode(selectedNode === d.sourceId ? null : d.sourceId)
        } else {
          // Cancel if back over source node
          const onSource = hitTestNodeRef.current() === d.sourceId
          if (onSource) {
            // cancelled
          } else {
            const targetId = hitTestNodeRef.current(d.sourceId)
            if (targetId !== null) {
              onAddEdge(d.sourceId, targetId)
            } else {
              const pt = intersectPlaneRef.current(d.plane)
              if (pt) {
                onBranchAt(d.sourceId, pt.x + c.x, -(pt.y - c.y), pt.z)
              }
            }
          }
        }
      }
    }

    dom.addEventListener('pointerup', handlePointerUp)
    return () => dom.removeEventListener('pointerup', handlePointerUp)
  }, [gl.domElement])

  // ─── Deselect on background click ─────────────────────────────────────────

  const onPointerMissed = useCallback(() => {
    // Only deselect if we weren't dragging
    if (!dragRef.current) onSelectNode(null)
  }, [onSelectNode])

  // Edge click for deletion
  const onEdgeClick = useCallback((e: any, a: number, b: number) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.stopPropagation()
    onDeleteEdge(a, b)
  }, [onDeleteEdge])

  return (
    <>
      <color attach="background" args={['#161616']} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[200, 200, 200]} intensity={0.8} />
      <directionalLight position={[-100, -100, -100]} intensity={0.3} />
      <OrbitControls ref={controlsRef} enablePan makeDefault />

      {/* Edges */}
      {graph.edges.map(([a, b], i) => {
        const na = graph.nodes.find(n => n.id === a)
        const nb = graph.nodes.find(n => n.id === b)
        if (!na || !nb) return null
        const pa: [number, number, number] = [na.x - center.x, -(na.y - center.y), na.z]
        const pb: [number, number, number] = [nb.x - center.x, -(nb.y - center.y), nb.z]
        const edgeKey = a < b ? `${a}-${b}` : `${b}-${a}`
        const isCut = cutHitEdges.has(edgeKey)
        return (
          <Line
            key={`e${i}`}
            points={[pa, pb]}
            color={isCut ? '#a44' : '#555'}
            lineWidth={isCut ? 3 : 1.5}
            onClick={(e: any) => onEdgeClick(e, a, b)}
          />
        )
      })}

      {/* Rubber-band line during edge drag */}
      {dragSourceId !== null && dragPoint && (() => {
        const source = graph.nodes.find(n => n.id === dragSourceId)
        if (!source) return null
        const pa: [number, number, number] = [source.x - center.x, -(source.y - center.y), source.z]
        const pb: [number, number, number] = [dragPoint.x, dragPoint.y, dragPoint.z]
        return (
          <Line
            points={[pa, pb]}
            color={hoverNodeId !== null ? '#8d8' : '#666'}
            lineWidth={1.5}
            dashed={hoverNodeId === null}
            dashSize={8}
            gapSize={6}
          />
        )
      })()}

      {/* Nodes */}
      {graph.nodes.map((node, index) => {
        const color = nodeColor(colors, index)
        const selected = node.id === selectedNode
        const isHover = node.id === hoverNodeId
        const isCut = cutHitNodes.has(node.id)
        return (
          <mesh
            key={node.id}
            position={[node.x - center.x, -(node.y - center.y), node.z]}
            onPointerDown={(e: any) => onPointerDown(e, node.id)}
            onPointerMissed={onPointerMissed}
          >
            <sphereGeometry args={[NODE_R, 20, 20]} />
            <meshBasicMaterial
              color={isCut ? new THREE.Color(0.7, 0.25, 0.25) : color}
            />
          </mesh>
        )
      })}
    </>
  )
}

// ─── Outer wrapper with cut mode ────────────────────────────────────────────

const EMPTY_SET_N = new Set<number>()
const EMPTY_SET_S = new Set<string>()
const SCREEN_NODE_R = 14  // screen-space hit radius for cut

export default function GraphEditor3D(props: GraphEditor3DProps) {
  const { graph, size, onBatchDelete } = props
  const cameraRef = useRef<THREE.Camera | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [cutPath, setCutPath] = useState<{ x: number; y: number }[]>([])
  const [cutHitNodes, setCutHitNodes] = useState<Set<number>>(EMPTY_SET_N)
  const [cutHitEdges, setCutHitEdges] = useState<Set<string>>(EMPTY_SET_S)
  const cutting = useRef(false)
  const cutDataRef = useRef<{ points: { x: number; y: number }[]; hitNodes: Set<number>; hitEdges: Set<string> }>({ points: [], hitNodes: new Set(), hitEdges: new Set() })

  // Project 3D graph position to screen-space pixel coords
  const toScreen = useCallback((node: { x: number; y: number; z: number }) => {
    const cam = cameraRef.current
    if (!cam || graph.nodes.length === 0) return { x: 0, y: 0 }
    // Compute center (same as scene)
    let cx = 0, cy = 0, cz = 0
    for (const n of graph.nodes) { cx += n.x; cy += n.y; cz += n.z }
    cx /= graph.nodes.length; cy /= graph.nodes.length; cz /= graph.nodes.length
    const v = new THREE.Vector3(node.x - cx, -(node.y - cy), node.z)
    v.project(cam)
    return { x: (v.x + 1) / 2 * size, y: (-v.y + 1) / 2 * size }
  }, [graph.nodes, size])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    e.stopPropagation()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    cutting.current = true
    cutDataRef.current = { points: [pt], hitNodes: new Set(), hitEdges: new Set() }
    setCutPath([pt])
    setCutHitNodes(new Set())
    setCutHitEdges(new Set())
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!cutting.current) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const cd = cutDataRef.current
    const prev = cd.points[cd.points.length - 1]

    // Check edges in screen space
    for (const [a, b] of graph.edges) {
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      if (cd.hitEdges.has(key)) continue
      const na = graph.nodes.find(n => n.id === a)
      const nb = graph.nodes.find(n => n.id === b)
      if (!na || !nb) continue
      const sa = toScreen(na), sb = toScreen(nb)
      if (segmentsIntersect(prev.x, prev.y, pt.x, pt.y, sa.x, sa.y, sb.x, sb.y)) {
        cd.hitEdges.add(key)
      }
    }

    // Check nodes in screen space
    for (const n of graph.nodes) {
      if (cd.hitNodes.has(n.id)) continue
      const sn = toScreen(n)
      if (pointToSegmentDistSq(sn.x, sn.y, prev.x, prev.y, pt.x, pt.y) < SCREEN_NODE_R * SCREEN_NODE_R) {
        cd.hitNodes.add(n.id)
      }
    }

    cd.points.push(pt)
    setCutPath([...cd.points])
    setCutHitNodes(new Set(cd.hitNodes))
    setCutHitEdges(new Set(cd.hitEdges))
  }, [graph.nodes, graph.edges, toScreen])

  const onPointerUp = useCallback(() => {
    if (!cutting.current) return
    cutting.current = false
    const cd = cutDataRef.current
    if (cd.hitNodes.size > 0 || cd.hitEdges.size > 0) {
      onBatchDelete(cd.hitNodes, cd.hitEdges)
    }
    setCutPath([])
    setCutHitNodes(EMPTY_SET_N)
    setCutHitEdges(EMPTY_SET_S)
  }, [onBatchDelete])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: size, height: size, borderRadius: '4px', overflow: 'hidden' }}
      onPointerDownCapture={onPointerDown}
      onPointerMoveCapture={onPointerMove}
      onPointerUpCapture={onPointerUp}
    >
      <Canvas
        camera={{ position: [0, 0, 400], fov: 50, near: 0.1, far: 50000 }}
        flat
        gl={{ antialias: true }}
        style={{ background: '#161616' }}
      >
        <GraphScene {...props} cutHitNodes={cutHitNodes} cutHitEdges={cutHitEdges} cameraRef={cameraRef} />
      </Canvas>
      {/* Cut path overlay */}
      {cutPath.length > 1 && (
        <svg style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, pointerEvents: 'none' }}>
          <polyline
            points={cutPath.map(p => `${p.x},${p.y}`).join(' ')}
            fill="none" stroke="#f44" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  )
}
