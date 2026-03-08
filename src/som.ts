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
export function runSOMBatch(
  palette: Float32Array,
  imageData: ImageData,
  rows: number,
  cols: number,
  fromIter: number,
  toIter: number,
  totalIter: number,
  blendStart: number,
  blendEnd: number,
  radiusStart: number,
  radiusEnd: number,
  tileable: boolean,
): void {
  const diagonal = Math.sqrt(rows * rows + cols * cols)
  const totalPixels = imageData.width * imageData.height

  for (let iter = fromIter; iter < toIter; iter++) {
    const progress = iter / totalIter
    const blend = blendStart + (blendEnd - blendStart) * progress
    const radius = (radiusStart + (radiusEnd - radiusStart) * progress) * diagonal
    const radiusSq = radius * radius

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
        let dx = col - bmuCol
        let dy = row - bmuRow
        if (tileable) {
          if (Math.abs(dx) > cols / 2) dx -= Math.sign(dx) * cols
          if (Math.abs(dy) > rows / 2) dy -= Math.sign(dy) * rows
        }
        if (dx * dx + dy * dy <= radiusSq) {
          const idx = (row * cols + col) * 3
          palette[idx] += (pr - palette[idx]) * blend
          palette[idx + 1] += (pg - palette[idx + 1]) * blend
          palette[idx + 2] += (pb - palette[idx + 2]) * blend
        }
      }
    }
  }
}

/** Render the raw palette as a grid of colored rectangles onto a canvas. */
export function renderPalette(
  canvas: HTMLCanvasElement,
  palette: Float32Array,
  rows: number,
  cols: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width
  const H = canvas.height
  const cellW = W / cols
  const cellH = H / rows
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 3
      const r = Math.round(Math.max(0, Math.min(1, palette[i])) * 255)
      const g = Math.round(Math.max(0, Math.min(1, palette[i + 1])) * 255)
      const b = Math.round(Math.max(0, Math.min(1, palette[i + 2])) * 255)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(
        Math.round(col * cellW),
        Math.round(row * cellH),
        Math.ceil(cellW),
        Math.ceil(cellH),
      )
    }
  }
}

/**
 * Blur the palette canvas.
 * In tileable mode, tiles 3×3 before blurring so edges are seamless.
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
  const blurPx = Math.round(W / 14)

  // Draw the sharp palette to a temp canvas first
  const tmp = document.createElement('canvas')
  tmp.width = W
  tmp.height = H
  renderPalette(tmp, palette, rows, cols)

  ctx.clearRect(0, 0, W, H)

  if (tileable) {
    // Create a 3×3 tiled canvas so the blur wraps seamlessly
    const large = document.createElement('canvas')
    large.width = W * 3
    large.height = H * 3
    const lCtx = large.getContext('2d')!
    for (let tx = 0; tx < 3; tx++) {
      for (let ty = 0; ty < 3; ty++) {
        lCtx.drawImage(tmp, tx * W, ty * H)
      }
    }
    // Draw the large canvas starting at (-W, -H) so the visible portion
    // of the display canvas is the center tile, blurred across tile seams.
    ctx.filter = `blur(${blurPx}px)`
    ctx.drawImage(large, -W, -H, W * 3, H * 3)
    ctx.filter = 'none'
  } else {
    ctx.filter = `blur(${blurPx}px)`
    ctx.drawImage(tmp, 0, 0)
    ctx.filter = 'none'
  }
}

/** Convert a palette entry at index `i` to a CSS hex string. */
export function toHex(palette: Float32Array, i: number): string {
  const r = Math.round(Math.max(0, Math.min(1, palette[i * 3])) * 255)
  const g = Math.round(Math.max(0, Math.min(1, palette[i * 3 + 1])) * 255)
  const b = Math.round(Math.max(0, Math.min(1, palette[i * 3 + 2])) * 255)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}
