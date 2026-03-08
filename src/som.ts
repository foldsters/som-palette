/**
 * Self-Organizing Map (SOM) palette extraction.
 *
 * Treats the palette as a 2D grid of colors. Each iteration:
 *  1. Samples a random pixel from the image.
 *  2. Finds the nearest palette cell (BMU – Best Matching Unit).
 *  3. Moves all cells within `radius` of the BMU toward the sampled color
 *     by a factor of `blend`.
 *
 * In tileable mode edges wrap, producing a seamless palette texture.
 * In traditional mode edges are open, producing HSV/RGB-slice-like corners.
 */
// Blend and radius both decay from 1.0 → 0.01 over training.
// `decay` controls the curve: 0.5 = linear, <0.5 = fast early drop, >0.5 = slow early drop.
// Internally: exponent = 10^(2*decay - 1), t = progress^exponent.
const SCHED_START = 1.0
const SCHED_END   = 0.01

export function runSOMBatch(
  palette: Float32Array,
  imageData: ImageData,
  rows: number,
  cols: number,
  fromIter: number,
  toIter: number,
  totalIter: number,
  blendDecay: number,
  radiusDecay: number,
  topology: 'traditional' | 'tileable' | 'sphere',
  gaussian: boolean,
): void {
  const diagonal = topology === 'sphere' ? Math.PI : Math.sqrt(rows * rows + cols * cols)
  const totalPixels = imageData.width * imageData.height
  const blendExp    = Math.pow(10, 2 * blendDecay - 1)
  const radiusExp   = Math.pow(10, 2 * radiusDecay - 1)

  for (let iter = fromIter; iter < toIter; iter++) {
    const progress = iter / totalIter
    const tBlend   = Math.pow(progress, blendExp)
    const tRadius  = Math.pow(progress, radiusExp)
    const blend    = SCHED_START + (SCHED_END - SCHED_START) * tBlend
    const radius   = (SCHED_START + (SCHED_END - SCHED_START) * tRadius) * diagonal

    // Sample random pixel
    const pi = Math.floor(Math.random() * totalPixels) * 4
    const pr = imageData.data[pi] / 255
    const pg = imageData.data[pi + 1] / 255
    const pb = imageData.data[pi + 2] / 255

    // Find BMU (closest palette cell in RGB space)
    let minDist = Infinity
    let bmuCol = 0
    let bmuRow = 0
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = (row * cols + col) * 3
        const dr = palette[idx] - pr
        const dg = palette[idx + 1] - pg
        const db = palette[idx + 2] - pb
        const d = dr * dr + dg * dg + db * db
        if (d < minDist) {
          minDist = d
          bmuCol = col
          bmuRow = row
        }
      }
    }

    // Update all cells within radius of BMU
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let dist: number
        if (topology === 'sphere') {
          const theta1 = (col     / cols) * 2 * Math.PI
          const phi1   = (row     / rows) * Math.PI
          const theta2 = (bmuCol  / cols) * 2 * Math.PI
          const phi2   = (bmuRow  / rows) * Math.PI
          const dot = Math.sin(phi1)*Math.sin(phi2)*Math.cos(theta1 - theta2) + Math.cos(phi1)*Math.cos(phi2)
          dist = Math.acos(Math.max(-1, Math.min(1, dot)))
        } else {
          let dx = col - bmuCol
          let dy = row - bmuRow
          if (topology === 'tileable') {
            if (Math.abs(dx) > cols / 2) dx -= Math.sign(dx) * cols
            if (Math.abs(dy) > rows / 2) dy -= Math.sign(dy) * rows
          }
          dist = Math.sqrt(dx * dx + dy * dy)
        }
        if (dist <= radius) {
          const h = gaussian ? (Math.exp(-(dist * dist) / (2 * radius * radius)) - 0.60653) / 0.39347 : 1.0
          const idx = (row * cols + col) * 3
          palette[idx]     += (pr - palette[idx])     * blend * h
          palette[idx + 1] += (pg - palette[idx + 1]) * blend * h
          palette[idx + 2] += (pb - palette[idx + 2]) * blend * h
        }
      }
    }
  }
}

/** Render the palette into a canvas sized cols×rows (1px per cell) via putImageData. */
export function renderPalette(
  canvas: HTMLCanvasElement,
  palette: Float32Array,
  rows: number,
  cols: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const img = ctx.createImageData(cols, rows)
  const d = img.data
  for (let i = 0; i < rows * cols; i++) {
    d[i * 4]     = Math.round(Math.max(0, Math.min(1, palette[i * 3]))     * 255)
    d[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, palette[i * 3 + 1])) * 255)
    d[i * 4 + 2] = Math.round(Math.max(0, Math.min(1, palette[i * 3 + 2])) * 255)
    d[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

/**
 * Blur the palette canvas using a separable Gaussian blur written directly
 * to pixel data (works correctly on export and avoids CSS-blur edge darkening).
 * In tileable mode edges wrap; otherwise they clamp.
 */
export function smoothPaletteCanvas(
  canvas: HTMLCanvasElement,
  palette: Float32Array,
  rows: number,
  cols: number,
  tileable: boolean,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height

  renderPalette(canvas, palette, rows, cols)

  const src = ctx.getImageData(0, 0, W, H).data
  const radius = Math.max(1, Math.round(Math.max(W, H) / 14))

  // Build normalised 1-D Gaussian kernel
  const sigma = radius / 3
  const kLen = radius * 2 + 1
  const kernel = new Float32Array(kLen)
  let kSum = 0
  for (let i = 0; i < kLen; i++) {
    const x = i - radius
    kernel[i] = Math.exp(-x * x / (2 * sigma * sigma))
    kSum += kernel[i]
  }
  for (let i = 0; i < kLen; i++) kernel[i] /= kSum

  const tmp = new Float32Array(W * H * 4)

  // Horizontal pass
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0
      for (let k = 0; k < kLen; k++) {
        let sx = x + k - radius
        if (tileable) sx = ((sx % W) + W) % W
        else sx = Math.max(0, Math.min(W - 1, sx))
        const i = (y * W + sx) * 4
        r += src[i]     * kernel[k]
        g += src[i + 1] * kernel[k]
        b += src[i + 2] * kernel[k]
      }
      const i = (y * W + x) * 4
      tmp[i] = r; tmp[i + 1] = g; tmp[i + 2] = b; tmp[i + 3] = 255
    }
  }

  // Vertical pass → write into a new ImageData
  const out = ctx.createImageData(W, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0
      for (let k = 0; k < kLen; k++) {
        let sy = y + k - radius
        if (tileable) sy = ((sy % H) + H) % H
        else sy = Math.max(0, Math.min(H - 1, sy))
        const i = (sy * W + x) * 4
        r += tmp[i]     * kernel[k]
        g += tmp[i + 1] * kernel[k]
        b += tmp[i + 2] * kernel[k]
      }
      const i = (y * W + x) * 4
      out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = 255
    }
  }

  ctx.putImageData(out, 0, 0)
}

/** Convert a palette entry at index `i` to a CSS hex string. */
export function toHex(palette: Float32Array, i: number): string {
  const r = Math.round(Math.max(0, Math.min(1, palette[i * 3])) * 255)
  const g = Math.round(Math.max(0, Math.min(1, palette[i * 3 + 1])) * 255)
  const b = Math.round(Math.max(0, Math.min(1, palette[i * 3 + 2])) * 255)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}
