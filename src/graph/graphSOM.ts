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
