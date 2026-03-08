import { useMemo, useRef, useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls, Line } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { convertVizCoords, VIZ_AXIS_COLORS, FRAME_TYPE, type VizSpace } from './colorSpaces'

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

function ImageCloud({ imageData, vizSpace }: { imageData: ImageData; vizSpace: VizSpace }) {
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
      col.push(r, g, b)
    }
    return { positions: new Float32Array(pos), colors: new Float32Array(col) }
  }, [imageData, vizSpace])

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.007} vertexColors transparent opacity={0.45} sizeAttenuation map={CIRCLE_TEX} alphaTest={0.1} />
    </points>
  )
}

function PaletteCloud({ palette, rows, cols, vizSpace }: { palette: Float32Array; rows: number; cols: number; vizSpace: VizSpace }) {
  const { positions, colors } = useMemo(() => {
    const count = rows * cols
    const pos = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const r = palette[i * 3], g = palette[i * 3 + 1], b = palette[i * 3 + 2]
      const [x, y, z] = convertVizCoords(r, g, b, vizSpace)
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z
      col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b
    }
    return { positions: pos, colors: col }
  }, [palette, rows, cols, vizSpace])

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.022} vertexColors sizeAttenuation map={CIRCLE_TEX} transparent alphaTest={0.5} />
    </points>
  )
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
}

export default function ColorCube({ imageData, palette, rows, cols, vizSpace, lightMode }: ColorCubeProps) {
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
      <color attach="background" args={[lightMode ? '#e8f0f8' : '#030810']} />
      <OrbitControls ref={controlsRef} enableZoom enableRotate makeDefault
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        onStart={() => { interacted.current = true }} />
      <group ref={pivotRef}>
        <group position={FRAME_TYPE[vizSpace] === 'cylinder' ? [0,0,0] : [-0.5,-0.5,-0.5]}>
          {FRAME_TYPE[vizSpace] === 'cylinder'
            ? <CylinderFrame vizSpace={vizSpace} lightMode={lightMode} />
            : <CubeFrame vizSpace={vizSpace} lightMode={lightMode} />}
          {imageData && <ImageCloud imageData={imageData} vizSpace={vizSpace} />}
          {palette && <PaletteCloud palette={palette} rows={rows} cols={cols} vizSpace={vizSpace} />}
        </group>
      </group>
    </>
  )
}

// ─── Topology scene (sphere / torus) ─────────────────────────────────────────

export interface TopologySceneProps {
  topology: 'rectangular' | 'cylindrical' | 'toroidal' | 'spherical'
  paletteCanvasRef: React.RefObject<HTMLCanvasElement | null>
}

export function TopologyScene({ topology, paletteCanvasRef }: TopologySceneProps) {
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null)
  const meshRef = useRef<THREE.Mesh>(null)
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const interacted = useRef(false)

  const textureRef = useRef<THREE.CanvasTexture | null>(null)
  const lastSize = useRef({ w: 0, h: 0 })

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
    const canvas = paletteCanvasRef.current
    if (canvas) {
      // Recreate texture if canvas dimensions changed (e.g. rows/cols updated)
      if (!textureRef.current || canvas.width !== lastSize.current.w || canvas.height !== lastSize.current.h) {
        textureRef.current?.dispose()
        const tex = new THREE.CanvasTexture(canvas)
        // Longitude wraps; latitude does not (sphere) but torus wraps both
        tex.wrapS = THREE.RepeatWrapping
        tex.wrapT = topology === 'toroidal' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
        // cylinder: open-ended, so no top/bottom cap seam issues
        textureRef.current = tex
        lastSize.current = { w: canvas.width, h: canvas.height }
        setTexture(tex)
      }
      textureRef.current!.needsUpdate = true
    }
    if (!interacted.current && meshRef.current) meshRef.current.rotation.y += delta * 0.25
  })

  useEffect(() => {
    return () => { textureRef.current?.dispose() }
  }, [])

  return (
    <>
      <OrbitControls ref={controlsRef} enableZoom enableRotate makeDefault
        mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
        onStart={() => { interacted.current = true }} />
      {texture && (
        topology === 'spherical' ? (
          <mesh ref={meshRef}>
            <sphereGeometry args={[0.5, 64, 32]} ref={(geo: THREE.SphereGeometry | null) => {
              if (!geo) return
              // All vertices in the north and south pole rings share one 3D point but
              // span U=0..1 by default, causing each triangle to sample a different
              // palette column → star-burst discontinuity. Fix: pin every pole vertex to U=0.5.
              const uv = geo.attributes.uv as THREE.BufferAttribute
              const W = 64, H = 32
              for (let i = 0; i <= W; i++) uv.setX(i, 0.5)
              for (let i = (W + 1) * H; i < (W + 1) * (H + 1); i++) uv.setX(i, 0.5)
              uv.needsUpdate = true
            }} />
            <meshBasicMaterial map={texture} />
          </mesh>
        ) : topology === 'cylindrical' ? (
          <mesh ref={meshRef}>
            <cylinderGeometry args={[0.35, 0.35, 0.7, 64, 1, true]} />
            <meshBasicMaterial map={texture} side={THREE.DoubleSide} />
          </mesh>
        ) : (
          <mesh ref={meshRef}>
            <torusGeometry args={[0.35, 0.2, 64, 128]} />
            <meshBasicMaterial map={texture} />
          </mesh>
        )
      )}
    </>
  )
}
