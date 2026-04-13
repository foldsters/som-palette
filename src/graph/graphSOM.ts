// ─── Graph Data Structure ────────────────────────────────────────────────────

export interface GraphNode {
  id: number
  x: number
  y: number
  z: number
}

export interface Graph {
  nodes: GraphNode[]
  edges: [number, number][]
  nextId: number
}

export function createGraph(cx: number, cy: number): Graph {
  return {
    nodes: [{ id: 0, x: cx, y: cy, z: 0 }],
    edges: [],
    nextId: 1,
  }
}

export function addNode(graph: Graph, parentId: number): Graph {
  const parent = graph.nodes.find(n => n.id === parentId)
  if (!parent) return graph
  const angle = Math.random() * Math.PI * 2
  const dist = 60 + Math.random() * 20
  const node: GraphNode = {
    id: graph.nextId,
    x: parent.x + Math.cos(angle) * dist,
    y: parent.y + Math.sin(angle) * dist,
    z: parent.z,
  }
  return {
    nodes: [...graph.nodes, node],
    edges: [...graph.edges, [parentId, node.id]],
    nextId: graph.nextId + 1,
  }
}

export function addNodeAt(graph: Graph, parentId: number, x: number, y: number, z = 0): Graph {
  const node: GraphNode = { id: graph.nextId, x, y, z }
  return {
    nodes: [...graph.nodes, node],
    edges: [...graph.edges, [parentId, node.id]],
    nextId: graph.nextId + 1,
  }
}

export function removeNode(graph: Graph, nodeId: number): Graph {
  return {
    nodes: graph.nodes.filter(n => n.id !== nodeId),
    edges: graph.edges.filter(([a, b]) => a !== nodeId && b !== nodeId),
    nextId: graph.nextId,
  }
}

export function addEdge(graph: Graph, a: number, b: number): Graph {
  if (a === b) return graph
  const exists = graph.edges.some(([ea, eb]) => (ea === a && eb === b) || (ea === b && eb === a))
  if (exists) return graph
  return { ...graph, edges: [...graph.edges, [a, b]] }
}

export function removeEdge(graph: Graph, a: number, b: number): Graph {
  return {
    ...graph,
    edges: graph.edges.filter(([ea, eb]) => !((ea === a && eb === b) || (ea === b && eb === a))),
  }
}

export function moveNode(graph: Graph, nodeId: number, x: number, y: number, z?: number): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map(n => n.id === nodeId ? { ...n, x, y, z: z ?? n.z } : n),
  }
}

export function batchDelete(graph: Graph, nodeIds: Set<number>, edgeKeys: Set<string>): Graph {
  const nodes = graph.nodes.filter(n => !nodeIds.has(n.id))
  // Keep at least one node
  if (nodes.length === 0 && graph.nodes.length > 0) nodes.push(graph.nodes[0])
  const keepNodeIds = new Set(nodes.map(n => n.id))
  const edges = graph.edges.filter(([a, b]) => {
    if (!keepNodeIds.has(a) || !keepNodeIds.has(b)) return false
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    return !edgeKeys.has(key)
  })
  return { nodes, edges, nextId: graph.nextId }
}

// ─── BFS Distance Matrix ────────────────────────────────────────────────────

export interface DistanceInfo {
  matrix: Float32Array  // N*N flat, row-major
  idToIndex: Map<number, number>
  diameter: number
}

export function computeDistanceMatrix(graph: Graph): DistanceInfo {
  const N = graph.nodes.length
  const idToIndex = new Map<number, number>()
  for (let i = 0; i < N; i++) idToIndex.set(graph.nodes[i].id, i)

  // Build adjacency by dense index
  const adj: number[][] = Array.from({ length: N }, () => [])
  for (const [a, b] of graph.edges) {
    const ai = idToIndex.get(a)
    const bi = idToIndex.get(b)
    if (ai !== undefined && bi !== undefined) {
      adj[ai].push(bi)
      adj[bi].push(ai)
    }
  }

  const matrix = new Float32Array(N * N).fill(Infinity)
  let diameter = 0

  // BFS from each node
  for (let src = 0; src < N; src++) {
    matrix[src * N + src] = 0
    const queue = [src]
    let head = 0
    while (head < queue.length) {
      const cur = queue[head++]
      const d = matrix[src * N + cur]
      for (const nb of adj[cur]) {
        if (matrix[src * N + nb] === Infinity) {
          matrix[src * N + nb] = d + 1
          if (d + 1 > diameter) diameter = d + 1
          queue.push(nb)
        }
      }
    }
  }

  return { matrix, idToIndex, diameter: diameter || 1 }
}

// ─── GSOM ────────────────────────────────────────────────────────────────────

export interface GSOMState {
  graph: Graph
  palette: Float32Array
  errors: Float32Array       // per-node accumulated error
  distMatrix: Float32Array
  idToIndex: Map<number, number>
  diameter: number
  phase: 'growing' | 'smoothing'
  iter: number
  growIter: number           // total growing phase iterations
  totalIter: number
  // Lattice mode: track grid positions
  gridCells: Map<string, number>   // "r,c" → node id
  gridPos: Map<number, [number, number]>  // node id → [r, c]
}

export function initGSOM(imageData: ImageData, cx: number, cy: number, totalIter: number, growRatio = 0.8): GSOMState {
  // Start with a single node
  const graph: Graph = {
    nodes: [{ id: 0, x: cx, y: cy, z: 0 }],
    edges: [],
    nextId: 1,
  }
  const N = 1
  const palette = initGraphPalette(imageData, N)
  const errors = new Float32Array(N)
  const { matrix, idToIndex, diameter } = computeDistanceMatrix(graph)
  const growIter = Math.floor(totalIter * growRatio)
  const gridCells = new Map<string, number>([['0,0', 0]])
  const gridPos = new Map<number, [number, number]>([[0, [0, 0]]])

  return { graph, palette, errors, distMatrix: matrix, idToIndex, diameter, phase: 'growing', iter: 0, growIter, totalIter, gridCells, gridPos }
}

function neighborCount(graph: Graph, nodeId: number): number {
  let count = 0
  for (const [a, b] of graph.edges) {
    if (a === nodeId || b === nodeId) count++
  }
  return count
}

export function runGSOMBatch(
  state: GSOMState,
  imageData: ImageData,
  batchSize: number,
  maxNodes: number,
  branchFactor = 2.5,
  lattice = false,
  blendDecay = 0.5,
  radiusDecay = 0.5,
): GSOMState {
  const { width, height, data } = imageData
  const totalPx = width * height

  let { graph, palette, errors, distMatrix, idToIndex, diameter, phase, iter, growIter, totalIter, gridCells, gridPos } = state
  let N = graph.nodes.length

  const blendExp  = Math.pow(10, 2 * blendDecay - 1)
  const radiusExp = Math.pow(10, 2 * radiusDecay - 1)

  // Schedule growth: linearly ramp from 1 to maxNodes across growing phase
  const nodesNeeded = Math.max(0, maxNodes - 1)
  const targetNodesAt = (it: number) => Math.min(maxNodes, 1 + (growIter > 0 ? Math.floor(nodesNeeded * it / growIter) : nodesNeeded))

  // Branching: max degree per node. branchFactor 2 = line, 3 = binary tree, etc.
  // Fractional part = probability of allowing one extra edge at that node.
  const maxDegree = Math.floor(branchFactor)
  const extraProb = branchFactor - maxDegree

  const toIter = Math.min(iter + batchSize, totalIter)

  for (; iter < toIter; iter++) {
    if (iter >= growIter && phase === 'growing') {
      phase = 'smoothing'
    }

    // Schedule: use phase-relative progress
    const phaseLen = phase === 'growing' ? growIter : (totalIter - growIter)
    const phaseIter = phase === 'growing' ? iter : (iter - growIter)
    const t = phaseLen <= 1 ? 1 : phaseIter / (phaseLen - 1)
    const maxRadius = diameter / 2
    const tBlend  = Math.pow(t, blendExp)
    const tRadius = Math.pow(t, radiusExp)
    const lr      = (phase === 'growing' ? 0.3 : 0.1) * (1 - tBlend)
    const sigma   = maxRadius * (1 - tRadius) + 0.5
    const sigma2  = 2 * sigma * sigma
    const cutoff  = sigma * 3

    // Sample random pixel
    const pi = Math.floor(Math.random() * totalPx) * 4
    const pr = data[pi] / 255, pg = data[pi + 1] / 255, pb = data[pi + 2] / 255

    // Find BMU
    let bmuIdx = 0, bmuDist = Infinity
    for (let i = 0; i < N; i++) {
      const dr = palette[i * 3] - pr
      const dg = palette[i * 3 + 1] - pg
      const db = palette[i * 3 + 2] - pb
      const d  = dr * dr + dg * dg + db * db
      if (d < bmuDist) { bmuDist = d; bmuIdx = i }
    }

    // Accumulate error on BMU
    errors[bmuIdx] += Math.sqrt(bmuDist)

    // Update neighbors
    for (let i = 0; i < N; i++) {
      const dist = distMatrix[bmuIdx * N + i]
      if (dist >= cutoff) continue
      const influence = lr * Math.exp(-dist * dist / sigma2)
      const idx = i * 3
      palette[idx]     += influence * (pr - palette[idx])
      palette[idx + 1] += influence * (pg - palette[idx + 1])
      palette[idx + 2] += influence * (pb - palette[idx + 2])
    }

    // Scheduled growth: add a node if we're behind target count
    if (phase === 'growing' && N < targetNodesAt(iter) && N < maxNodes) {
      if (lattice) {
        // Lattice growth: find boundary node with highest error that has an empty grid neighbor
        const DIRS: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]]
        const SPACING = 80
        let bestIdx = -1, bestErr = -1, bestDir: [number, number] = [0, 1]
        for (let i = 0; i < N; i++) {
          const pos = gridPos.get(graph.nodes[i].id)
          if (!pos) continue
          // Check if this node has any empty adjacent grid cell
          for (const [dr, dc] of DIRS) {
            const key = `${pos[0] + dr},${pos[1] + dc}`
            if (!gridCells.has(key) && errors[i] > bestErr) {
              bestErr = errors[i]; bestIdx = i; bestDir = [dr, dc]
            }
          }
        }
        if (bestIdx >= 0) {
          const parent = graph.nodes[bestIdx]
          const parentPos = gridPos.get(parent.id)!
          const nr = parentPos[0] + bestDir[0], nc = parentPos[1] + bestDir[1]
          const newNode: GraphNode = {
            id: graph.nextId,
            x: parent.x + bestDir[1] * SPACING,
            y: parent.y + bestDir[0] * SPACING,
            z: parent.z,
          }
          // Connect to all existing grid neighbors (forms squares)
          const newEdges: [number, number][] = []
          for (const [dr, dc] of DIRS) {
            const adjKey = `${nr + dr},${nc + dc}`
            const adjId = gridCells.get(adjKey)
            if (adjId !== undefined) newEdges.push([adjId, newNode.id])
          }
          graph = {
            nodes: [...graph.nodes, newNode],
            edges: [...graph.edges, ...newEdges],
            nextId: graph.nextId + 1,
          }
          gridCells.set(`${nr},${nc}`, newNode.id)
          gridPos.set(newNode.id, [nr, nc])

          const newPalette = new Float32Array((N + 1) * 3)
          newPalette.set(palette)
          newPalette[N * 3]     = palette[bestIdx * 3]     + (Math.random() - 0.5) * 0.1
          newPalette[N * 3 + 1] = palette[bestIdx * 3 + 1] + (Math.random() - 0.5) * 0.1
          newPalette[N * 3 + 2] = palette[bestIdx * 3 + 2] + (Math.random() - 0.5) * 0.1
          palette = newPalette

          const newErrors = new Float32Array(N + 1)
          newErrors.set(errors)
          errors[bestIdx] = 0
          errors = newErrors
          N++

          const info = computeDistanceMatrix(graph)
          distMatrix = info.matrix; idToIndex = info.idToIndex; diameter = info.diameter
        }
      } else {
        // Tree growth: find node with highest error under branching limit
        let bestIdx = -1, bestErr = -1
        for (let i = 0; i < N; i++) {
          const nCount = neighborCount(graph, graph.nodes[i].id)
          const allowed = maxDegree + (Math.random() < extraProb ? 1 : 0)
          if (nCount < allowed && errors[i] > bestErr) {
            bestErr = errors[i]; bestIdx = i
          }
        }
        if (bestIdx === -1) {
          for (let i = 0; i < N; i++) {
            if (errors[i] > bestErr) { bestErr = errors[i]; bestIdx = i }
          }
        }
        if (bestIdx >= 0) {
          const parent = graph.nodes[bestIdx]
          const angle = Math.random() * Math.PI * 2
          const d = 60 + Math.random() * 20
          const newNode: GraphNode = {
            id: graph.nextId,
            x: parent.x + Math.cos(angle) * d,
            y: parent.y + Math.sin(angle) * d,
            z: parent.z,
          }
          graph = {
            nodes: [...graph.nodes, newNode],
            edges: [...graph.edges, [parent.id, newNode.id]],
            nextId: graph.nextId + 1,
          }
          const newPalette = new Float32Array((N + 1) * 3)
          newPalette.set(palette)
          newPalette[N * 3]     = palette[bestIdx * 3]     + (Math.random() - 0.5) * 0.1
          newPalette[N * 3 + 1] = palette[bestIdx * 3 + 1] + (Math.random() - 0.5) * 0.1
          newPalette[N * 3 + 2] = palette[bestIdx * 3 + 2] + (Math.random() - 0.5) * 0.1
          palette = newPalette

          const newErrors = new Float32Array(N + 1)
          newErrors.set(errors)
          errors[bestIdx] = 0
          errors = newErrors
          N++

          const info = computeDistanceMatrix(graph)
          distMatrix = info.matrix; idToIndex = info.idToIndex; diameter = info.diameter
        }
      }
    }
  }

  return { graph, palette, errors, distMatrix, idToIndex, diameter, phase, iter, growIter, totalIter, gridCells, gridPos }
}

// ─── SOM ─────────────────────────────────────────────────────────────────────

export function initGraphPalette(imageData: ImageData, n: number): Float32Array {
  const { width, height, data } = imageData
  const totalPx = width * height
  const palette = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const pi = Math.floor(Math.random() * totalPx) * 4
    palette[i * 3]     = data[pi]     / 255
    palette[i * 3 + 1] = data[pi + 1] / 255
    palette[i * 3 + 2] = data[pi + 2] / 255
  }
  return palette
}

export function runGraphSOMBatch(
  palette: Float32Array,
  imageData: ImageData,
  distMatrix: Float32Array,
  n: number,
  diameter: number,
  fromIter: number,
  toIter: number,
  totalIter: number,
  blendDecay = 0.5,
  radiusDecay = 0.5,
) {
  const { width, height, data } = imageData
  const totalPx = width * height
  const maxRadius = diameter / 2
  const blendExp  = Math.pow(10, 2 * blendDecay - 1)
  const radiusExp = Math.pow(10, 2 * radiusDecay - 1)

  for (let iter = fromIter; iter < toIter; iter++) {
    const t       = totalIter <= 1 ? 1 : iter / (totalIter - 1)
    const tBlend  = Math.pow(t, blendExp)
    const tRadius = Math.pow(t, radiusExp)
    const lr      = 0.5 * (1 - tBlend)
    const sigma   = maxRadius * (1 - tRadius) + 0.5
    const sigma2  = 2 * sigma * sigma
    const cutoff  = sigma * 3

    // Sample random pixel
    const pi = Math.floor(Math.random() * totalPx) * 4
    const pr = data[pi] / 255, pg = data[pi + 1] / 255, pb = data[pi + 2] / 255

    // Find BMU
    let bmuIdx = 0, bmuDist = Infinity
    for (let i = 0; i < n; i++) {
      const dr = palette[i * 3] - pr
      const dg = palette[i * 3 + 1] - pg
      const db = palette[i * 3 + 2] - pb
      const d  = dr * dr + dg * dg + db * db
      if (d < bmuDist) { bmuDist = d; bmuIdx = i }
    }

    // Update neighbors
    for (let i = 0; i < n; i++) {
      const dist = distMatrix[bmuIdx * n + i]
      if (dist >= cutoff) continue
      const influence = lr * Math.exp(-dist * dist / sigma2)
      const idx = i * 3
      palette[idx]     += influence * (pr - palette[idx])
      palette[idx + 1] += influence * (pg - palette[idx + 1])
      palette[idx + 2] += influence * (pb - palette[idx + 2])
    }
  }
}
