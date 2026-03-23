// ─── WebGL2-accelerated SOM for EdgeConfig topologies ────────────────────────
//
// Architecture mirrors src/glSOM.ts but instead of a fixed topology enum,
// we encode the full EdgeConfig as uniforms so the shader can replicate
// gridDistance() exactly.
//
// The distance computation in GLSL follows topology.ts:gridDistance:
//   1. Generate image positions of the BMU via hJoin/vJoin wrap/twist
//   2. Take the minimum Euclidean distance to any image
//   3. For each collapsed-edge pole group (precomputed on CPU, passed as
//      uniforms), add a through-pole candidate: poleDistA + poleDistB
//
// Pole groups are precomputed by pinchedPoleUniforms() on the CPU side
// (same union-find logic as topology.ts) and uploaded as:
//   u_numPoles        — number of pole groups (0..4)
//   u_poleEdges[i]    — bitmask of edges in group i (bits: top=1,bot=2,left=4,right=8)
//
// The shader reconstructs edgeDist(edge, pos) = distance to that grid edge,
// then takes min over edges in the group — matching the CPU exactly.

// ─── Shaders ─────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

// Each fragment = one palette cell (floor(v_uv * u_size) = grid pos in GPU coords,
// y=0 at bottom). BMU is also in GPU coords.
const FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_palette;
uniform vec2  u_size;       // vec2(cols, rows)
uniform vec2  u_bmu;        // BMU in GPU coords (y=0 at bottom)
uniform vec3  u_color;
uniform float u_blend;
uniform float u_sigma;      // neighbourhood sigma (grid cells)
uniform float u_cutoff;     // 3*sigma cutoff

// EdgeConfig ints: 0=free, 1=wrap, 2=twist
uniform int u_hJoin;
uniform int u_vJoin;

// Collapsed poles — up to 4 groups.
// u_poleEdges[i] bits: 1=top, 2=bottom, 4=left, 8=right
uniform int u_numPoles;
uniform int u_poleEdges[4];

in  vec2 v_uv;
out vec4 o_color;

// Distance from grid pos p to a specific edge of the grid
float edgeDist(vec2 p, int edgeBit) {
  // GPU coords: y=0 at bottom, y=rows-1 at top
  // top edge (CPU top = GPU top = y=rows-1): dist = rows-1-p.y
  // bottom edge (CPU bottom = GPU bottom = y=0): dist = p.y
  // left:  dist = p.x
  // right: dist = cols-1-p.x
  if (edgeBit == 1) return u_size.y - 1.0 - p.y;  // top
  if (edgeBit == 2) return p.y;                     // bottom
  if (edgeBit == 4) return p.x;                     // left
  return u_size.x - 1.0 - p.x;                      // right
}

// Minimum distance from pos to all edges in a pole group bitmask
float poleDist(vec2 pos, int mask) {
  float d = 1e9;
  if ((mask &  1) != 0) d = min(d, edgeDist(pos,  1));
  if ((mask &  2) != 0) d = min(d, edgeDist(pos,  2));
  if ((mask &  4) != 0) d = min(d, edgeDist(pos,  4));
  if ((mask &  8) != 0) d = min(d, edgeDist(pos,  8));
  return d;
}

// Squared Euclidean distance
float dist2(vec2 a, vec2 b) {
  vec2 d = a - b;
  return dot(d, d);
}

void main() {
  vec3 current = texture(u_palette, v_uv).rgb;
  vec2 pos = floor(v_uv * u_size);   // GPU grid coords

  // ── 1. Image positions of BMU ──────────────────────────────────────────────
  // Start with direct image
  float best2 = dist2(pos, u_bmu);

  // hJoin images (shift col by ±cols, possibly flip row)
  if (u_hJoin == 1) {  // wrap
    best2 = min(best2, dist2(pos, vec2(u_bmu.x - u_size.x, u_bmu.y)));
    best2 = min(best2, dist2(pos, vec2(u_bmu.x + u_size.x, u_bmu.y)));
  } else if (u_hJoin == 2) {  // twist: flip GPU row = rows-1-bmu.y
    float fr = u_size.y - 1.0 - u_bmu.y;
    best2 = min(best2, dist2(pos, vec2(u_bmu.x - u_size.x, fr)));
    best2 = min(best2, dist2(pos, vec2(u_bmu.x + u_size.x, fr)));
  }

  // vJoin images — must cross with each existing hJoin image
  // We need to iterate over the h-images generated above.
  // Since GLSL doesn't have dynamic arrays, expand manually (max 3 h-images).
  // For each h-image (hbx, hby), produce ±rows shift (and possible col-flip).
  //
  // Collect h-images into fixed-size array
  vec2 him[3];
  int  nhim = 1;
  him[0] = u_bmu;
  if (u_hJoin == 1) {
    him[1] = vec2(u_bmu.x - u_size.x, u_bmu.y);
    him[2] = vec2(u_bmu.x + u_size.x, u_bmu.y);
    nhim = 3;
  } else if (u_hJoin == 2) {
    float fr = u_size.y - 1.0 - u_bmu.y;
    him[1] = vec2(u_bmu.x - u_size.x, fr);
    him[2] = vec2(u_bmu.x + u_size.x, fr);
    nhim = 3;
  }

  if (u_vJoin == 1) {  // wrap
    for (int i = 0; i < nhim; i++) {
      best2 = min(best2, dist2(pos, vec2(him[i].x, him[i].y - u_size.y)));
      best2 = min(best2, dist2(pos, vec2(him[i].x, him[i].y + u_size.y)));
    }
  } else if (u_vJoin == 2) {  // twist: flip GPU col = cols-1-him[i].x
    for (int i = 0; i < nhim; i++) {
      float fc = u_size.x - 1.0 - him[i].x;
      best2 = min(best2, dist2(pos, vec2(fc, him[i].y - u_size.y)));
      best2 = min(best2, dist2(pos, vec2(fc, him[i].y + u_size.y)));
    }
  }

  float d = sqrt(best2);

  // ── 2. Through-pole candidates ────────────────────────────────────────────
  // Unrolled — uniform loop bounds can miscompile on some drivers
  if (u_numPoles > 0) { float c0 = poleDist(pos, u_poleEdges[0]) + poleDist(u_bmu, u_poleEdges[0]); d = min(d, c0); }
  if (u_numPoles > 1) { float c1 = poleDist(pos, u_poleEdges[1]) + poleDist(u_bmu, u_poleEdges[1]); d = min(d, c1); }
  if (u_numPoles > 2) { float c2 = poleDist(pos, u_poleEdges[2]) + poleDist(u_bmu, u_poleEdges[2]); d = min(d, c2); }
  if (u_numPoles > 3) { float c3 = poleDist(pos, u_poleEdges[3]) + poleDist(u_bmu, u_poleEdges[3]); d = min(d, c3); }

  // ── 3. Apply neighbourhood influence ──────────────────────────────────────
  if (d < u_cutoff) {
    float sigma2 = 2.0 * u_sigma * u_sigma;
    float h = exp(-d * d / sigma2);
    o_color = vec4(mix(current, u_color, u_blend * h), 1.0);
  } else {
    o_color = vec4(current, 1.0);
  }
}`

// ─── GL helpers ───────────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error')
  return sh
}

function linkProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const prog = gl.createProgram()!
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vert))
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, frag))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog) ?? 'link error')
  return prog
}

function makeQuadVAO(gl: WebGL2RenderingContext, prog: WebGLProgram): WebGLVertexArrayObject {
  const vao = gl.createVertexArray()!
  gl.bindVertexArray(vao)
  const buf = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return vao
}

function makeFloatTex(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null)
  return tex
}

function makeFBO(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw new Error('framebuffer incomplete')
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  return fbo
}

// ─── Pole group precomputation ────────────────────────────────────────────────
//
// Mirrors the union-find in topology.ts:pinchedPoleFns, but returns
// bitmasks (top=1, bottom=2, left=4, right=8) instead of closures.
// Returns at most 4 groups (at most 4 edges).

import type { EdgeConfig } from './topology'

type EdgeName = 'top' | 'bottom' | 'left' | 'right'
const EDGE_BIT: Record<EdgeName, number> = { top: 1, bottom: 2, left: 4, right: 8 }
const EDGE_ADJACENT: [EdgeName, EdgeName][] = [
  ['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right'],
]

function pinchedPoleMasks(cfg: EdgeConfig): number[] {
  const collapsed: EdgeName[] = []
  if (cfg.top    === 'pinched') collapsed.push('top')
  if (cfg.bottom === 'pinched') collapsed.push('bottom')
  if (cfg.left   === 'pinched') collapsed.push('left')
  if (cfg.right  === 'pinched') collapsed.push('right')
  if (collapsed.length === 0) return []

  const parent = new Map<EdgeName, EdgeName>(collapsed.map(e => [e, e]))
  const find = (x: EdgeName): EdgeName => {
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
    return parent.get(x)!
  }
  for (const [a, b] of EDGE_ADJACENT) {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b))
  }
  if (cfg.vJoin !== 'free' && parent.has('top')  && parent.has('bottom')) parent.set(find('top'),  find('bottom'))
  if (cfg.hJoin !== 'free' && parent.has('left') && parent.has('right'))  parent.set(find('left'), find('right'))

  const groups = new Map<EdgeName, number>()
  for (const e of collapsed) {
    const root = find(e)
    groups.set(root, (groups.get(root) ?? 0) | EDGE_BIT[e])
  }
  return Array.from(groups.values())
}

// ─── GLSOM ────────────────────────────────────────────────────────────────────

export class GLSOM {
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private vao: WebGLVertexArrayObject
  private textures: [WebGLTexture, WebGLTexture]
  private fbos:     [WebGLFramebuffer, WebGLFramebuffer]
  private current:  0 | 1 = 0

  private rows = 0
  private cols = 0
  private readBuf:   Float32Array = new Float32Array(0)
  private pbo:       WebGLBuffer | null = null
  private pboFilled  = false

  // CPU mirror in top-to-bottom row order (matches canvas rendering).
  // Updated from GPU at the start of each runBatch (one batch latency).
  cpuMirror: Float32Array = new Float32Array(0)

  private uSize:     WebGLUniformLocation
  private uBMU:      WebGLUniformLocation
  private uColor:    WebGLUniformLocation
  private uBlend:    WebGLUniformLocation
  private uSigma:    WebGLUniformLocation
  private uCutoff:   WebGLUniformLocation
  private uHJoin: WebGLUniformLocation
  private uVJoin: WebGLUniformLocation
  private uNumPoles: WebGLUniformLocation
  private uPoleEdges: WebGLUniformLocation

  static isSupported(): boolean {
    try {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2')
      return !!gl && !!gl.getExtension('EXT_color_buffer_float')
    } catch { return false }
  }

  constructor() {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) throw new Error('WebGL2 not supported')
    if (!gl.getExtension('EXT_color_buffer_float'))
      throw new Error('EXT_color_buffer_float unavailable')
    this.gl = gl

    this.prog = linkProgram(gl, VERT, FRAG)
    this.vao  = makeQuadVAO(gl, this.prog)

    gl.useProgram(this.prog)
    gl.uniform1i(gl.getUniformLocation(this.prog, 'u_palette'), 0)

    const u = (n: string) => gl.getUniformLocation(this.prog, n)!
    this.uSize     = u('u_size')
    this.uBMU      = u('u_bmu')
    this.uColor    = u('u_color')
    this.uBlend    = u('u_blend')
    this.uSigma    = u('u_sigma')
    this.uCutoff   = u('u_cutoff')
    this.uHJoin = u('u_hJoin')
    this.uVJoin = u('u_vJoin')
    this.uNumPoles = u('u_numPoles')
    this.uPoleEdges = gl.getUniformLocation(this.prog, 'u_poleEdges[0]')!

    this.textures = [makeFloatTex(gl, 1, 1), makeFloatTex(gl, 1, 1)]
    this.fbos     = [makeFBO(gl, this.textures[0]), makeFBO(gl, this.textures[1])]
  }

  init(rows: number, cols: number): void {
    const gl = this.gl
    this.rows = rows
    this.cols = cols
    this.cpuMirror = new Float32Array(rows * cols * 3)
    this.readBuf   = new Float32Array(rows * cols * 4)
    this.pboFilled = false

    const zeros = new Float32Array(rows * cols * 4)
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, zeros)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)

    if (!this.pbo) this.pbo = gl.createBuffer()!
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo)
    gl.bufferData(gl.PIXEL_PACK_BUFFER, rows * cols * 4 * 4, gl.STREAM_READ)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)

    this.current = 0
  }

  // Upload cpuMirror (top-to-bottom, RGB) to both ping-pong textures.
  uploadMirror(): void {
    const { rows, cols } = this
    const gl = this.gl
    const data = new Float32Array(rows * cols * 4)
    for (let i = 0; i < rows * cols; i++) {
      // GPU stores rows bottom-to-top; cpuMirror is top-to-bottom.
      const cpuRow = Math.floor(i / cols)
      const col    = i % cols
      const gpuRow = rows - 1 - cpuRow
      const src = (cpuRow * cols + col) * 3
      const dst = (gpuRow * cols + col) * 4
      data[dst]     = this.cpuMirror[src]
      data[dst + 1] = this.cpuMirror[src + 1]
      data[dst + 2] = this.cpuMirror[src + 2]
      data[dst + 3] = 1.0
    }
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, data)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.current = 0
  }

  private syncPBO(): void {
    const gl = this.gl
    const { rows, cols } = this
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo!)
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuf)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    this.pboFilled = false
    const mirror = this.cpuMirror
    for (let row = 0; row < rows; row++) {
      const gpuRow = rows - 1 - row
      for (let col = 0; col < cols; col++) {
        const src = (gpuRow * cols + col) * 4
        const dst = (row    * cols + col) * 3
        mirror[dst]     = this.readBuf[src]
        mirror[dst + 1] = this.readBuf[src + 1]
        mirror[dst + 2] = this.readBuf[src + 2]
      }
    }
  }

  flush(): void {
    if (this.pboFilled) this.syncPBO()
  }

  runBatch(
    imageData: ImageData,
    fromIter: number,
    toIter: number,
    totalIter: number,
    cfg: EdgeConfig,
  ): void {
    const { rows, cols } = this
    const maxRadius = Math.max(rows, cols) / 2
    const totalPx   = imageData.width * imageData.height
    const gl        = this.gl
    const mirror    = this.cpuMirror

    if (this.pboFilled) this.syncPBO()

    // Precompute pole masks (same for whole batch — cfg doesn't change)
    const poleMasks = pinchedPoleMasks(cfg)
    const numPoles  = poleMasks.length
    const poleArr   = new Int32Array(4)
    for (let i = 0; i < numPoles; i++) poleArr[i] = poleMasks[i]

    const hPinched = cfg.left === 'pinched' && cfg.right === 'pinched'
    const vPinched = cfg.top  === 'pinched' && cfg.bottom === 'pinched'
    const hInt = hPinched ? 0 : cfg.hJoin === 'wrap' ? 1 : cfg.hJoin === 'twist' ? 2 : 0
    const vInt = vPinched ? 0 : cfg.vJoin === 'wrap' ? 1 : cfg.vJoin === 'twist' ? 2 : 0

    gl.useProgram(this.prog)
    gl.bindVertexArray(this.vao)
    gl.viewport(0, 0, cols, rows)
    gl.uniform2f(this.uSize, cols, rows)
    gl.uniform1i(this.uHJoin, hInt)
    gl.uniform1i(this.uVJoin, vInt)
    gl.uniform1i(this.uNumPoles, numPoles)
    gl.uniform1iv(this.uPoleEdges, poleArr)

    for (let iter = fromIter; iter < toIter; iter++) {
      const t      = iter / (totalIter - 1)
      const lr     = 0.5 * Math.exp(-t * 4)
      const sigma  = maxRadius * Math.exp(-t * 4) + 0.5
      const cutoff = sigma * 3

      const pi = Math.floor(Math.random() * totalPx) * 4
      const pr = imageData.data[pi]     / 255
      const pg = imageData.data[pi + 1] / 255
      const pb = imageData.data[pi + 2] / 255

      // BMU search on CPU mirror (top-to-bottom)
      let bmuDist = Infinity, bmuRow = 0, bmuCol = 0
      for (let i = 0; i < rows * cols; i++) {
        const dr = mirror[i * 3]     - pr
        const dg = mirror[i * 3 + 1] - pg
        const db = mirror[i * 3 + 2] - pb
        const d  = dr * dr + dg * dg + db * db
        if (d < bmuDist) {
          bmuDist = d
          bmuRow  = Math.floor(i / cols)
          bmuCol  = i % cols
        }
      }

      const src = this.current
      const dst = (1 - this.current) as 0 | 1
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.textures[src])
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[dst])

      // Convert BMU row from CPU order (top=0) to GPU order (bottom=0)
      gl.uniform2f(this.uBMU, bmuCol, rows - 1 - bmuRow)
      gl.uniform3f(this.uColor, pr, pg, pb)
      gl.uniform1f(this.uBlend, lr)
      gl.uniform1f(this.uSigma, sigma)
      gl.uniform1f(this.uCutoff, cutoff)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      this.current = dst
    }

    // Async readback via PBO
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbos[this.current])
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo!)
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    this.pboFilled = true

    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.prog)
    gl.deleteVertexArray(this.vao)
    this.textures.forEach(t => gl.deleteTexture(t))
    this.fbos.forEach(f => gl.deleteFramebuffer(f))
    if (this.pbo) gl.deleteBuffer(this.pbo)
  }
}
