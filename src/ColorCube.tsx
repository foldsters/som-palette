import { useMemo, useRef, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls, Line } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { convertVizCoords, linearize, VIZ_AXIS_COLORS, FRAME_TYPE, type VizSpace } from './colorSpaces'

// ─── Circle sprite texture (created once) ────────────────────────────────────

function makeCircleTex() {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'white'
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fill()
  return new THREE.CanvasTexture(canvas)
}
const CIRCLE_TEX = makeCircleTex()

// ─── RGB cube sub-components ─────────────────────────────────────────────────

function ImageCloud({ imageData, vizSpace, compress, lightMode }: { imageData: ImageData; vizSpace: VizSpace; compress: boolean; lightMode: boolean }) {
  const { positions, colors } = useMemo(() => {
    const maxPoints = 8000
    const total = imageData.width * imageData.height
    const step = Math.max(1, Math.floor(total / maxPoints))
    const pos: number[] = []
    const col: number[] = []
    for (let i = 0; i < total; i += step) {
      const r = imageData.data[i * 4] / 255
      const g = imageData.data[i * 4 + 1] / 255
      const b = imageData.data[i * 4 + 2] / 255
      const [x, y, z] = convertVizCoords(r, g, b, vizSpace)
      pos.push(x, y, z)
      const cr = compress ? (lightMode ? r * 0.5 : r * 0.5 + 0.5) : r
      const cg = compress ? (lightMode ? g * 0.5 : g * 0.5 + 0.5) : g
      const cb = compress ? (lightMode ? b * 0.5 : b * 0.5 + 0.5) : b
      col.push(linearize(cr), linearize(cg), linearize(cb))
    }
    return { positions: new Float32Array(pos), colors: new Float32Array(col) }
  }, [imageData, vizSpace, compress, lightMode])

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.007} vertexColors transparent opacity={0.45} sizeAttenuation alphaMap={CIRCLE_TEX} alphaTest={0.2} depthWrite={false} />
    </points>
  )
}

function PaletteCloud({ palette, rows, cols, vizSpace, compress, lightMode }: { palette: Float32Array; rows: number; cols: number; vizSpace: VizSpace; compress: boolean; lightMode: boolean }) {
  const { positions, colors } = useMemo(() => {
    const count = rows * cols
    const pos = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const r = palette[i * 3], g = palette[i * 3 + 1], b = palette[i * 3 + 2]
      const [x, y, z] = convertVizCoords(r, g, b, vizSpace)
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z
      const cr = compress ? (lightMode ? r * 0.5 : r * 0.5 + 0.5) : r
      const cg = compress ? (lightMode ? g * 0.5 : g * 0.5 + 0.5) : g
      const cb = compress ? (lightMode ? b * 0.5 : b * 0.5 + 0.5) : b
      col[i * 3] = linearize(cr); col[i * 3 + 1] = linearize(cg); col[i * 3 + 2] = linearize(cb)
    }
    return { positions: pos, colors: col }
  }, [palette, rows, cols, vizSpace, compress, lightMode])

  const pointSize = Math.max(0.007, 0.022 * Math.sqrt(64 / (rows * cols)))

  return (
    <points renderOrder={1}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={pointSize} vertexColors sizeAttenuation alphaMap={CIRCLE_TEX} transparent alphaTest={0.5} />
    </points>
  )
}

type Topology = 'rectangular' | 'cylindrical' | 'toroidal' | 'spherical' | 'projective' | 'mobius' | 'klein' | 'cone' | 'bicone'

function PaletteGrid({ palette, rows, cols, vizSpace, compress, lightMode, topology }: { palette: Float32Array; rows: number; cols: number; vizSpace: VizSpace; compress: boolean; lightMode: boolean; topology: Topology }) {
  const { positions, colors } = useMemo(() => {
    const pos: number[] = [], col: number[] = []
    function push(i: number, j: number) {
      for (const idx of [i, j]) {
        const r = palette[idx * 3], g = palette[idx * 3 + 1], b = palette[idx * 3 + 2]
        const [x, y, z] = convertVizCoords(r, g, b, vizSpace)
        pos.push(x, y, z)
        const cr = compress ? (lightMode ? r * 0.5 : r * 0.5 + 0.5) : r
        const cg = compress ? (lightMode ? g * 0.5 : g * 0.5 + 0.5) : g
        const cb = compress ? (lightMode ? b * 0.5 : b * 0.5 + 0.5) : b
        col.push(linearize(cr), linearize(cg), linearize(cb))
      }
    }
    // Interior edges
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) push(row * cols + c, row * cols + c + 1)
        if (row + 1 < rows) push(row * cols + c, (row + 1) * cols + c)
      }
    }
    // Wrap edges by topology
    if (topology === 'cylindrical' || topology === 'toroidal' || topology === 'spherical' || topology === 'projective') {
      for (let row = 0; row < rows; row++)
        push(row * cols + (cols - 1), row * cols)
    }
    if (topology === 'mobius' || topology === 'klein') {
      for (let row = 0; row < rows; row++)
        push(row * cols + (cols - 1), (rows - 1 - row) * cols)
    }
    if (topology === 'toroidal' || topology === 'klein') {
      for (let c = 0; c < cols; c++)
        push((rows - 1) * cols + c, c)
    }
    return { positions: new Float32Array(pos), colors: new Float32Array(col) }
  }, [palette, rows, cols, vizSpace, compress, lightMode, topology])

  if (positions.length === 0) return null
  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <lineBasicMaterial vertexColors transparent opacity={0.5} />
    </lineSegments>
  )
}

// ─── Topology mesh geometry builders ─────────────────────────────────────────

function makeMobiusGeometry(): THREE.BufferGeometry {
  const NU = 128, NV = 16
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []
  const R = 0.32, w = 0.14
  for (let i = 0; i <= NU; i++) {
    const u = (i / NU) * 2 * Math.PI
    const cosU = Math.cos(u), sinU = Math.sin(u)
    const cosHU = Math.cos(u / 2), sinHU = Math.sin(u / 2)
    for (let j = 0; j <= NV; j++) {
      const v = (j / NV - 0.5) * 2 * w
      positions.push((R + v * cosHU) * cosU, v * sinHU, (R + v * cosHU) * sinU)
      uvs.push(i / NU, j / NV)
    }
  }
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j
      indices.push(a, a + NV + 1, a + 1, a + 1, a + NV + 1, a + NV + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

function makeKleinGeometry(): THREE.BufferGeometry {
  // Figure-8 immersion: x=(2+cos(u/2)sin(v)-sin(u/2)sin(2v))cos(u), etc.
  const NU = 128, NV = 64, scale = 0.18
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []
  for (let i = 0; i <= NU; i++) {
    const u = (i / NU) * 2 * Math.PI
    const cosU = Math.cos(u), sinU = Math.sin(u)
    const cosHU = Math.cos(u / 2), sinHU = Math.sin(u / 2)
    for (let j = 0; j <= NV; j++) {
      const v = (j / NV) * 2 * Math.PI
      const sinV = Math.sin(v), sin2V = Math.sin(2 * v)
      const r = 2 + cosHU * sinV - sinHU * sin2V
      positions.push(r * cosU * scale, (sinHU * sinV + cosHU * sin2V) * scale, r * sinU * scale)
      uvs.push(i / NU, j / NV)
    }
  }
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const a = i * (NV + 1) + j
      indices.push(a, a + NV + 1, a + 1, a + 1, a + NV + 1, a + NV + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

function makeConeGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.42,  0.35, 0,  // top-left  (palette top)
     0.42,  0.35, 0,  // top-right (palette top)
     0.0,  -0.35, 0,  // apex      (palette bottom = point)
  ], 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 1,    // top-left:  palette top row  (v=1 with flipY)
    1, 1,    // top-right: palette top row
    0.5, 0,  // apex:      palette bottom row (v=0 with flipY)
  ], 2))
  geo.setIndex([0, 2, 1])
  geo.computeVertexNormals()
  return geo
}

function makeBigonGeometry(): THREE.BufferGeometry {
  // Lens shape: two pole vertices connected by arced sides (like a 2-gon / vesica).
  // Width is zero at the poles and maximal at the equator.
  const NV = 48, NH = 32, H = 0.42, W = 0.30
  const positions: number[] = [], uvs: number[] = [], indices: number[] = []
  for (let i = 0; i <= NV; i++) {
    const tv = i / NV
    const y = H * (1 - 2 * tv)
    const w = W * Math.sin(Math.PI * tv)
    for (let j = 0; j <= NH; j++) {
      const th = j / NH
      positions.push((th - 0.5) * 2 * w, y, 0)
      uvs.push(th, 1 - tv)  // v=1 = palette top, v=0 = palette bottom (flipY)
    }
  }
  for (let i = 0; i < NV; i++) {
    for (let j = 0; j < NH; j++) {
      const a = i * (NH + 1) + j
      indices.push(a, a + NH + 1, a + 1, a + 1, a + NH + 1, a + NH + 2)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return geo
}

// ─── Frame geometry — computed once outside components so refs are stable ─────

const CUBE_EDGES: [[number,number,number],[number,number,number]][] = [
  [[0,0,0],[1,0,0]], [[1,0,0],[1,1,0]], [[1,1,0],[0,1,0]], [[0,1,0],[0,0,0]],
  [[0,0,1],[1,0,1]], [[1,0,1],[1,1,1]], [[1,1,1],[0,1,1]], [[0,1,1],[0,0,1]],
  [[0,0,0],[0,0,1]], [[1,0,0],[1,0,1]], [[1,1,0],[1,1,1]], [[0,1,0],[0,1,1]],
]

const CYL_N = 64
const cylRing = (y: number): [number,number,number][] =>
  Array.from({ length: CYL_N + 1 }, (_, i) => {
    const θ = (i / CYL_N) * 2 * Math.PI
    return [0.5 * Math.cos(θ), y, 0.5 * Math.sin(θ)]
  })
const CYL_RING_BOT = cylRing(-0.5)
const CYL_RING_MID = cylRing(0)
const CYL_RING_TOP = cylRing(0.5)

const CYL_N_SPOKES = 8
const CYL_SPOKES: [[number,number,number],[number,number,number]][] =
  Array.from({ length: CYL_N_SPOKES }, (_, i) => {
    const θ = (i / CYL_N_SPOKES) * 2 * Math.PI
    return [[0.5 * Math.cos(θ), -0.5, 0.5 * Math.sin(θ)],
            [0.5 * Math.cos(θ),  0.5, 0.5 * Math.sin(θ)]]
  })

// ─── Frame components ─────────────────────────────────────────────────────────

function CubeFrame({ vizSpace, lightMode }: { vizSpace: VizSpace; lightMode: boolean }) {
  const [cx, cy, cz] = VIZ_AXIS_COLORS[vizSpace]
  const edge = lightMode ? '#b8cce0' : '#152844'
  return (
    <>
      {CUBE_EDGES.map(([a, b], i) => <Line key={i} points={[a, b]} color={edge} lineWidth={1} />)}
      <Line points={[[0,0,0],[1.12,0,0]]} color={cx} lineWidth={2} />
      <Line points={[[0,0,0],[0,1.12,0]]} color={cy} lineWidth={2} />
      <Line points={[[0,0,0],[0,0,1.12]]} color={cz} lineWidth={2} />
    </>
  )
}

function CylinderFrame({ vizSpace, lightMode }: { vizSpace: VizSpace; lightMode: boolean }) {
  const [,, lColor] = VIZ_AXIS_COLORS[vizSpace]
  const edge = lightMode ? '#b8cce0' : '#152844'
  const mid  = lightMode ? '#888888' : '#555555'
  return (
    <>
      <Line points={CYL_RING_BOT} color={edge} lineWidth={1} />
      <Line points={CYL_RING_TOP} color={edge} lineWidth={1} />
      {CYL_SPOKES.map(([a, b], i) => <Line key={i} points={[a, b]} color={edge} lineWidth={1} />)}
      <Line points={CYL_RING_MID} color={mid} lineWidth={2} />
      <Line points={[[0,-0.5,0],[0,0.65,0]]} color={lColor} lineWidth={2} />
    </>
  )
}

// ─── RGB cube scene ───────────────────────────────────────────────────────────

export interface ColorCubeProps {
  imageData: ImageData | null
  palette: Float32Array | null
  rows: number
  cols: number
  vizSpace: VizSpace
  lightMode: boolean
  compress: boolean
  topology: Topology
}

export default function ColorCube({ imageData, palette, rows, cols, vizSpace, lightMode, compress, topology }: ColorCubeProps) {
  const pivotRef = useRef<THREE.Group>(null)
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const interacted = useRef(false)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && controlsRef.current) controlsRef.current.mouseButtons.LEFT = THREE.MOUSE.PAN
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' && controlsRef.current) controlsRef.current.mouseButtons.LEFT = THREE.MOUSE.ROTATE
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  useFrame((_, delta) => {
    if (!interacted.current && pivotRef.current) pivotRef.current.rotation.y += delta * 0.25
  })

  return (
    <>
      <color attach="background" args={[lightMode ? '#e4f0fa' : '#030810']} />
      <OrbitControls ref={controlsRef} enableZoom enableRotate makeDefault
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        onStart={() => { interacted.current = true }} />
      <group ref={pivotRef}>
        <group position={FRAME_TYPE[vizSpace] === 'cylinder' ? [0,0,0] : [-0.5,-0.5,-0.5]}>
          {FRAME_TYPE[vizSpace] === 'cylinder'
            ? <CylinderFrame vizSpace={vizSpace} lightMode={lightMode} />
            : <CubeFrame vizSpace={vizSpace} lightMode={lightMode} />}
          {imageData && <ImageCloud imageData={imageData} vizSpace={vizSpace} compress={compress} lightMode={lightMode} />}
          {palette && <PaletteGrid palette={palette} rows={rows} cols={cols} vizSpace={vizSpace} compress={compress} lightMode={lightMode} topology={topology} />}
          {palette && <PaletteCloud palette={palette} rows={rows} cols={cols} vizSpace={vizSpace} compress={compress} lightMode={lightMode} />}
        </group>
      </group>
    </>
  )
}

// ─── Topology scene (sphere / torus) ─────────────────────────────────────────

export interface TopologySceneProps {
  paletteCanvasRef: React.RefObject<HTMLCanvasElement | null>
  // Mutable refs so useFrame always reads the latest value even across R3F's
  // separate reconciler boundary (plain prop values can go stale there).
  lightModeRef: React.MutableRefObject<boolean>
  topologyRef: React.MutableRefObject<string>
  paletteReadyRef: React.MutableRefObject<boolean>
  rowsRef: React.MutableRefObject<number>
  colsRef: React.MutableRefObject<number>
}

function applyTopologyGeometry(mesh: THREE.Mesh, topology: string, rows: number, cols: number) {
  mesh.geometry.dispose()
  const mat = mesh.material as THREE.MeshBasicMaterial
  if (topology === 'spherical' || topology === 'projective') {
    const geo = new THREE.SphereGeometry(0.5, 64, 32)
    // Fix pole UVs: pin every pole vertex to U=0.5 to avoid star-burst seams.
    const uv = geo.attributes.uv as THREE.BufferAttribute
    const W = 64, H = 32
    for (let i = 0; i <= W; i++) uv.setX(i, 0.5)
    for (let i = (W + 1) * H; i < (W + 1) * (H + 1); i++) uv.setX(i, 0.5)
    uv.needsUpdate = true
    mesh.geometry = geo
    mat.side = THREE.FrontSide
  } else if (topology === 'cylindrical') {
    mesh.geometry = new THREE.CylinderGeometry(0.35, 0.35, 0.7, 64, 1, true)
    mat.side = THREE.DoubleSide
  } else if (topology === 'rectangular') {
    const aspect = cols / rows
    const w = aspect >= 1 ? 0.7 : 0.7 * aspect
    const h = aspect >= 1 ? 0.7 / aspect : 0.7
    mesh.geometry = new THREE.PlaneGeometry(w, h)
    mat.side = THREE.DoubleSide
  } else if (topology === 'hexagonal') {
    // True hex grid dimensions: width ≈ cols + 0.5 (stagger), height = rows * √3/2
    const hexW = cols + 0.5
    const hexH = rows * Math.sqrt(3) / 2
    const aspect = hexW / hexH
    const w = aspect >= 1 ? 0.7 : 0.7 * aspect
    const h = aspect >= 1 ? 0.7 / aspect : 0.7
    mesh.geometry = new THREE.PlaneGeometry(w, h)
    mat.side = THREE.DoubleSide
  } else if (topology === 'cone') {
    mesh.geometry = makeConeGeometry()
    mat.side = THREE.DoubleSide
  } else if (topology === 'bicone') {
    mesh.geometry = makeBigonGeometry()
    mat.side = THREE.DoubleSide
  } else if (topology === 'mobius') {
    mesh.geometry = makeMobiusGeometry()
    mat.side = THREE.DoubleSide
  } else if (topology === 'klein') {
    mesh.geometry = makeKleinGeometry()
    mat.side = THREE.DoubleSide
  } else {
    mesh.geometry = new THREE.TorusGeometry(0.35, 0.2, 64, 128)
    mat.side = THREE.FrontSide
  }
  mat.needsUpdate = true
}

export function TopologyScene({ paletteCanvasRef, lightModeRef, topologyRef, paletteReadyRef, rowsRef, colsRef }: TopologySceneProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const interacted  = useRef(false)

  // Create mesh + material imperatively so R3F's reconciler never touches them.
  const mesh = useMemo(() => {
    const mat = new THREE.MeshBasicMaterial()
    const geo = new THREE.TorusGeometry(0.35, 0.2, 64, 128) // replaced on first frame
    return new THREE.Mesh(geo, mat)
  }, [])

  const textureRef           = useRef<THREE.CanvasTexture | null>(null)
  const lastSize             = useRef({ w: 0, h: 0 })
  const lastTopology         = useRef('')
  const lastDimensions       = useRef({ rows: 0, cols: 0 })
  const lastLightModeForBg   = useRef<boolean | null>(null)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control' && controlsRef.current) controlsRef.current.mouseButtons.LEFT = THREE.MOUSE.PAN
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' && controlsRef.current) controlsRef.current.mouseButtons.LEFT = THREE.MOUSE.ROTATE
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  useEffect(() => {
    return () => {
      textureRef.current?.dispose()
      mesh.geometry.dispose()
      ;(mesh.material as THREE.MeshBasicMaterial).dispose()
    }
  }, [mesh])

  useFrame((state, delta) => {
    const mat = mesh.material as THREE.MeshBasicMaterial
    const topology  = topologyRef.current
    const lightMode = lightModeRef.current
    const ready     = paletteReadyRef.current

    // ── Scene background ────────────────────────────────────────────────────
    if (lightMode !== lastLightModeForBg.current) {
      lastLightModeForBg.current = lightMode
      state.scene.background = new THREE.Color(lightMode ? 0xe4f0fa : 0x030810)
    }

    // ── Topology geometry swap (also re-runs when rectangular dimensions change) ─
    const rows = rowsRef.current, cols = colsRef.current
    const dimsChanged = rows !== lastDimensions.current.rows || cols !== lastDimensions.current.cols
    if (topology !== lastTopology.current || (topology === 'rectangular' && dimsChanged)) {
      lastTopology.current = topology
      lastDimensions.current = { rows, cols }
      applyTopologyGeometry(mesh, topology, rows, cols)
      if (textureRef.current) {
        textureRef.current.wrapS = (topology === 'toroidal' || topology === 'cylindrical' || topology === 'spherical' || topology === 'projective' || topology === 'klein') ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
        textureRef.current.wrapT = (topology === 'toroidal' || topology === 'klein') ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
        textureRef.current.needsUpdate = true
      }
    }

    // ── Texture update from palette canvas ──────────────────────────────────
    const canvas = paletteCanvasRef.current
    if (canvas && ready) {
      if (!textureRef.current || canvas.width !== lastSize.current.w || canvas.height !== lastSize.current.h) {
        textureRef.current?.dispose()
        const tex = new THREE.CanvasTexture(canvas)
        tex.colorSpace = THREE.SRGBColorSpace
        tex.wrapS = (topology === 'toroidal' || topology === 'cylindrical' || topology === 'spherical' || topology === 'projective' || topology === 'klein') ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
        tex.wrapT = (topology === 'toroidal' || topology === 'klein') ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
        textureRef.current = tex
        lastSize.current = { w: canvas.width, h: canvas.height }
        mat.map = tex
        mat.needsUpdate = true
      }
      textureRef.current!.needsUpdate = true
    } else if (!ready && textureRef.current) {
      textureRef.current.dispose()
      textureRef.current = null
      lastSize.current = { w: 0, h: 0 }
      mat.map = null
      mat.needsUpdate = true
    }

    // ── Colour — set every frame so lightMode flips apply instantly ─────────
    const hasTex = ready && !!textureRef.current
    mat.color.setHex(hasTex ? 0xffffff : (lightMode ? 0xffffff : 0x0f2540))

    // ── Auto-rotation ───────────────────────────────────────────────────────
    if (!interacted.current) mesh.rotation.y += delta * 0.25
  })

  return (
    <>
      <OrbitControls ref={controlsRef} enableZoom enableRotate makeDefault
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        onStart={() => { interacted.current = true }} />
      {/* primitive skips R3F reconciliation — all properties are managed imperatively */}
      <primitive object={mesh} />
    </>
  )
}
