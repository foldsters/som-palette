
// ─── Shaders ─────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

// Each fragment = one palette cell.
// Reads current color from u_palette, updates it if within radius of BMU.
// u_bmu is in GPU coordinates (y=0 at bottom, matching OpenGL convention).
const FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_palette;
uniform vec2 u_size;      // vec2(cols, rows)
uniform vec2 u_bmu;       // BMU grid position in GPU coords (y=0 at bottom)
uniform vec3 u_color;     // sampled pixel RGB [0,1]
uniform float u_blend;
uniform float u_radius;   // neighbourhood radius in grid cells
uniform int u_topology;  // 0=rectangular 1=cylindrical 2=toroidal 3=spherical 4=hexagonal 5=projective 6=mobius 7=klein
uniform bool u_gaussian;

#define PI 3.14159265358979

float sphereDist(vec2 pos1, vec2 pos2, vec2 size) {
  float theta1 = (pos1.x / size.x) * 2.0 * PI;
  float phi1   = (pos1.y / size.y) * PI;
  float theta2 = (pos2.x / size.x) * 2.0 * PI;
  float phi2   = (pos2.y / size.y) * PI;
  float d = sin(phi1)*sin(phi2)*cos(theta1 - theta2) + cos(phi1)*cos(phi2);
  return acos(clamp(d, -1.0, 1.0));
}

in vec2 v_uv;
out vec4 o_color;

void main() {
  vec3 current = texture(u_palette, v_uv).rgb;

  vec2 gridPos = floor(v_uv * u_size);
  float d;
  if (u_topology == 3) {
    d = sphereDist(gridPos, u_bmu, u_size);
  } else if (u_topology == 5) {
    // RP²: real projective plane — identify antipodal points
    float d1 = sphereDist(gridPos, u_bmu, u_size);
    // Antipodal BMU: theta += π (x + size.x/2 mod size.x), phi → π-phi (y → size.y - y)
    vec2 anti_bmu = vec2(mod(u_bmu.x + u_size.x * 0.5, u_size.x), u_size.y - u_bmu.y);
    float d2 = sphereDist(gridPos, anti_bmu, u_size);
    d = min(d1, d2);
  } else if (u_topology == 4) {
    // Hexagonal: odd CPU-rows (= odd GPU-rows when flipped) offset by 0.5 in x.
    // u_bmu.x already includes the BMU's own hex offset (added on CPU side).
    float cpuRow = u_size.y - 1.0 - gridPos.y;
    float ox = mod(cpuRow, 2.0) >= 1.0 ? 0.5 : 0.0;
    float dx = (gridPos.x + ox) - u_bmu.x;
    float dy = (gridPos.y - u_bmu.y) * 0.8660254; // sqrt(3)/2
    d = length(vec2(dx, dy));
  } else if (u_topology == 6) {
    // Möbius band: horizontal wraps with row flip, vertical is open
    float flipRow = u_size.y - 1.0 - u_bmu.y;
    float d0 = length(gridPos - u_bmu);
    float d1 = length(vec2(gridPos.x - (u_bmu.x + u_size.x), gridPos.y - flipRow));
    float d2 = length(vec2(gridPos.x - (u_bmu.x - u_size.x), gridPos.y - flipRow));
    d = min(d0, min(d1, d2));
  } else if (u_topology == 7) {
    // Klein bottle: vertical wraps same, horizontal wraps with row flip (odd wraps)
    float flipRow = u_size.y - 1.0 - u_bmu.y;
    float best = 1e9;
    // n in {-1,0,1}: odd n → flip row; m in {-1,0,1}: vertical wrap
    for (int n = -1; n <= 1; n++) {
      float er = (n == 0) ? u_bmu.y : flipRow;  // n=±1 are odd → flip
      for (int m = -1; m <= 1; m++) {
        float dy = gridPos.y - (er + float(m) * u_size.y);
        float dx = gridPos.x - (u_bmu.x + float(n) * u_size.x);
        best = min(best, dx*dx + dy*dy);
      }
    }
    d = sqrt(best);
  } else {
    vec2 diff = gridPos - u_bmu;
    if (u_topology == 2) {
      if (abs(diff.x) > u_size.x * 0.5) diff.x -= sign(diff.x) * u_size.x;
      if (abs(diff.y) > u_size.y * 0.5) diff.y -= sign(diff.y) * u_size.y;
    } else if (u_topology == 1) {
      if (abs(diff.x) > u_size.x * 0.5) diff.x -= sign(diff.x) * u_size.x;
    }
    d = length(diff);
  }
  if (d <= u_radius) {
    float h = u_gaussian ? (exp(-d * d / (2.0 * u_radius * u_radius)) - 0.60653) / 0.39347 : 1.0;
    o_color = vec4(mix(current, u_color, u_blend * h), 1.0);
  } else {
    o_color = vec4(current, 1.0);
  }
}`

// ─── GL helpers ──────────────────────────────────────────────────────────────

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
  // Triangle strip covering clip space [-1,1]²
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

// ─── GLSOM ───────────────────────────────────────────────────────────────────

export class GLSOM {
  private gl: WebGL2RenderingContext
  private prog: WebGLProgram
  private vao: WebGLVertexArrayObject
  private textures: [WebGLTexture, WebGLTexture]
  private fbos: [WebGLFramebuffer, WebGLFramebuffer]
  private current: 0 | 1 = 0

  private rows = 0
  private cols = 0
  private readBuf: Float32Array = new Float32Array(0)  // RGBA readback scratch

  // CPU mirror of palette in top-to-bottom row order (matches 2D canvas rendering).
  // Updated from GPU at the end of every runBatch call.
  readonly mirror: Float32Array[] = []   // re-assigned on init
  cpuMirror: Float32Array = new Float32Array(0)

  private uSize: WebGLUniformLocation
  private uBMU: WebGLUniformLocation
  private uColor: WebGLUniformLocation
  private uBlend: WebGLUniformLocation
  private uRadius: WebGLUniformLocation
  private uTopology: WebGLUniformLocation
  private uGaussian: WebGLUniformLocation

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
    this.uSize    = gl.getUniformLocation(this.prog, 'u_size')!
    this.uBMU     = gl.getUniformLocation(this.prog, 'u_bmu')!
    this.uColor   = gl.getUniformLocation(this.prog, 'u_color')!
    this.uBlend   = gl.getUniformLocation(this.prog, 'u_blend')!
    this.uRadius  = gl.getUniformLocation(this.prog, 'u_radius')!
    this.uTopology = gl.getUniformLocation(this.prog, 'u_topology')!
    this.uGaussian = gl.getUniformLocation(this.prog, 'u_gaussian')!

    this.textures = [makeFloatTex(gl, 1, 1), makeFloatTex(gl, 1, 1)]
    this.fbos     = [makeFBO(gl, this.textures[0]), makeFBO(gl, this.textures[1])]
  }

  /** Resize textures and reset palette to black. */
  init(rows: number, cols: number): void {
    const gl = this.gl
    this.rows = rows
    this.cols = cols
    this.cpuMirror = new Float32Array(rows * cols * 3)
    this.readBuf   = new Float32Array(rows * cols * 4)

    const zeros = new Float32Array(rows * cols * 4)
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, zeros)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.current = 0
  }

  /** Upload cpuMirror to both ping-pong textures (call after externally modifying cpuMirror). */
  uploadMirror(): void {
    const { rows, cols } = this
    const gl = this.gl
    const data = new Float32Array(rows * cols * 4)
    for (let i = 0; i < rows * cols; i++) {
      data[i * 4]     = this.cpuMirror[i * 3]
      data[i * 4 + 1] = this.cpuMirror[i * 3 + 1]
      data[i * 4 + 2] = this.cpuMirror[i * 3 + 2]
      data[i * 4 + 3] = 1.0
    }
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures[i])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, cols, rows, 0, gl.RGBA, gl.FLOAT, data)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
    this.current = 0
  }

  /**
   * Run fromIter..toIter SOM iterations on the GPU.
   * CPU mirror is used for BMU search (stale by up to one batch — fine for SOM).
   * Mirror is synced from GPU at the end of each call.
   */
  runBatch(
    imageData: ImageData,
    fromIter: number,
    toIter: number,
    totalIter: number,
    blendDecay: number,
    radiusDecay: number,
    topology: 'rectangular' | 'cylindrical' | 'toroidal' | 'spherical' | 'hexagonal' | 'projective' | 'mobius' | 'klein',
    gaussian: boolean,
  ): void {
    const { rows, cols } = this
    const diagonal = topology === 'projective' ? Math.PI / 2 : topology === 'spherical' ? Math.PI : Math.sqrt(rows * rows + cols * cols)
    const totalPixels = imageData.width * imageData.height
    const gl          = this.gl
    const mirror      = this.cpuMirror
    const blendExp    = Math.pow(10, 2 * blendDecay - 1)
    const radiusExp   = Math.pow(10, 2 * radiusDecay - 1)

    gl.useProgram(this.prog)
    gl.bindVertexArray(this.vao)
    gl.viewport(0, 0, cols, rows)
    gl.uniform2f(this.uSize, cols, rows)

    for (let iter = fromIter; iter < toIter; iter++) {
      const progress = iter / totalIter
      const tBlend   = Math.pow(progress, blendExp)
      const tRadius  = Math.pow(progress, radiusExp)
      const blend    = 1.0 + (0.01 - 1.0) * tBlend
      const radius   = (1.0 + (0.01 - 1.0) * tRadius) * diagonal

      // Sample random pixel from image
      const pi = Math.floor(Math.random() * totalPixels) * 4
      const rr = imageData.data[pi]     / 255
      const rg = imageData.data[pi + 1] / 255
      const rb = imageData.data[pi + 2] / 255
      const [r, g, b] = [rr, rg, rb]

      // BMU search on CPU mirror (top-to-bottom row order)
      let minDist = Infinity, bmuCol = 0, bmuRow = 0
      for (let i = 0; i < rows * cols; i++) {
        const dr = mirror[i * 3]     - r
        const dg = mirror[i * 3 + 1] - g
        const db = mirror[i * 3 + 2] - b
        const d  = dr * dr + dg * dg + db * db
        if (d < minDist) {
          minDist = d
          bmuCol  = i % cols
          bmuRow  = Math.floor(i / cols)
        }
      }

      // GPU update pass — ping-pong textures
      const src = this.current
      const dst = (1 - this.current) as 0 | 1

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.textures[src])
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[dst])

      // Convert BMU row from CPU order (top=0) to GPU order (bottom=0).
      // For hex: pre-apply the CPU-row-based x-offset so the shader stays consistent.
      const bmuX = topology === 'hexagonal' ? bmuCol + (bmuRow % 2) * 0.5 : bmuCol
      gl.uniform2f(this.uBMU, bmuX, rows - 1 - bmuRow)
      gl.uniform3f(this.uColor, r, g, b)
      gl.uniform1f(this.uBlend, blend)
      gl.uniform1f(this.uRadius, radius)
      gl.uniform1i(this.uTopology,
        topology === 'rectangular'  ? 0 :
        topology === 'cylindrical'  ? 1 :
        topology === 'toroidal'     ? 2 :
        topology === 'hexagonal'    ? 4 :
        topology === 'projective'   ? 5 :
        topology === 'mobius'       ? 6 :
        topology === 'klein'        ? 7 : 3)
      gl.uniform1i(this.uGaussian, gaussian ? 1 : 0)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      this.current = dst
    }

    // Sync CPU mirror from GPU (readPixels returns bottom-to-top)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbos[this.current])
    gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.FLOAT, this.readBuf)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)

    for (let row = 0; row < rows; row++) {
      const gpuRow = rows - 1 - row   // flip: GPU bottom-row → CPU top-row
      for (let col = 0; col < cols; col++) {
        const src = (gpuRow * cols + col) * 4
        const dst = (row    * cols + col) * 3
        mirror[dst]     = this.readBuf[src]
        mirror[dst + 1] = this.readBuf[src + 1]
        mirror[dst + 2] = this.readBuf[src + 2]
      }
    }

    gl.bindVertexArray(null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteProgram(this.prog)
    gl.deleteVertexArray(this.vao)
    this.textures.forEach(t => gl.deleteTexture(t))
    this.fbos.forEach(f => gl.deleteFramebuffer(f))
  }
}
