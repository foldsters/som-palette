import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls, Line } from '@react-three/drei'
import * as THREE from 'three'

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Point cloud sampled from the source image, colored by RGB. */
function ImageCloud({ imageData }: { imageData: ImageData }) {
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
      pos.push(r, g, b)
      col.push(r, g, b)
    }
    return {
      positions: new Float32Array(pos),
      colors: new Float32Array(col),
    }
  }, [imageData])

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.007} vertexColors transparent opacity={0.45} sizeAttenuation />
    </points>
  )
}

/** Palette colors as bright dots, larger than the image cloud. */
function PaletteCloud({ palette, rows, cols }: { palette: Float32Array; rows: number; cols: number }) {
  const { positions, colors } = useMemo(() => {
    const count = rows * cols
    const pos = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = palette[i * 3]
      pos[i * 3 + 1] = palette[i * 3 + 1]
      pos[i * 3 + 2] = palette[i * 3 + 2]
      col[i * 3]     = palette[i * 3]
      col[i * 3 + 1] = palette[i * 3 + 1]
      col[i * 3 + 2] = palette[i * 3 + 2]
    }
    return { positions: pos, colors: col }
  }, [palette, rows, cols])

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.022} vertexColors sizeAttenuation />
    </points>
  )
}

/** Wireframe RGB unit cube + colored axis rays. */
function CubeFrame() {
  const edges: [[number, number, number], [number, number, number]][] = [
    // bottom
    [[0,0,0],[1,0,0]], [[1,0,0],[1,1,0]], [[1,1,0],[0,1,0]], [[0,1,0],[0,0,0]],
    // top
    [[0,0,1],[1,0,1]], [[1,0,1],[1,1,1]], [[1,1,1],[0,1,1]], [[0,1,1],[0,0,1]],
    // verticals
    [[0,0,0],[0,0,1]], [[1,0,0],[1,0,1]], [[1,1,0],[1,1,1]], [[0,1,0],[0,1,1]],
  ]

  return (
    <>
      {edges.map(([a, b], i) => (
        <Line key={i} points={[a, b]} color="#152844" lineWidth={1} />
      ))}
      <Line points={[[0,0,0],[1.12,0,0]]} color="#ff4040" lineWidth={2} />
      <Line points={[[0,0,0],[0,1.12,0]]} color="#40ff40" lineWidth={2} />
      <Line points={[[0,0,0],[0,0,1.12]]} color="#4080ff" lineWidth={2} />
    </>
  )
}

// ─── Scene ───────────────────────────────────────────────────────────────────

export interface ColorCubeProps {
  imageData: ImageData | null
  palette: Float32Array | null
  rows: number
  cols: number
}

export default function ColorCube({ imageData, palette, rows, cols }: ColorCubeProps) {
  const groupRef = useRef<THREE.Group>(null)
  const interacted = useRef(false)

  useFrame((_, delta) => {
    if (!interacted.current && groupRef.current) {
      groupRef.current.rotation.y += delta * 0.25
    }
  })

  return (
    <>
      <OrbitControls
        enablePan={false}
        enableZoom
        enableRotate
        makeDefault
        onStart={() => { interacted.current = true }}
      />
      {/* Offset so the RGB cube is centered at world origin */}
      <group ref={groupRef} position={[-0.5, -0.5, -0.5]}>
        <CubeFrame />
        {imageData && <ImageCloud imageData={imageData} />}
        {palette && <PaletteCloud palette={palette} rows={rows} cols={cols} />}
      </group>
    </>
  )
}
