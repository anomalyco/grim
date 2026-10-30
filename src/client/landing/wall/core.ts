// Shared plumbing for the wall: the view (scroll and window, in page px), a seeded-free random toolkit, small WebGL2
// helpers, and one batched "coloured triangles in page px" program that the strikes, cracks, hole rim and debris all
// draw with. No parameters to tune here: each piece keeps its own at the top of its module.

/** Where the window is on the page, in CSS px, and the canvas resolution. Updated once per frame by index.ts. */
export interface View {
  sx: number;
  sy: number;
  vw: number;
  vh: number;
  dpr: number;
  /** the page shake (px), added to everything the wall draws */
  shakeX: number;
  shakeY: number;
  /** a phone or tablet: lower resolution, fewer pieces, simpler crawlers */
  low: boolean;
  /** the pointer, in page px (crawlers look at it) */
  px: number;
  py: number;
}

export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};
/** a normal-ish random number (mean 0, sd about 1) */
export const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.73;

/** A tiny deterministic random source, so a crack edge shared by two cells jags the same way for both. */
export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("wall shader: " + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("wall program: " + gl.getProgramInfoLog(p));
  return p;
}

export function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]) {
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return u;
}

/** A full-window triangle for full-screen passes (no attributes: gl_VertexID). */
export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** In a full-screen pass: this fragment's position on the page, in CSS px. */
export const PAGE_POS_GLSL = `
uniform vec4 uView;   // scrollX, scrollY, viewport w, h (CSS px)
uniform vec3 uShake;  // shake x, y (px), dpr
vec2 pagePos() {
  vec2 c = gl_FragCoord.xy / uShake.z;
  return vec2(uView.x + c.x, uView.y + (uView.w - c.y)) - uShake.xy;
}`;

export function setViewUniforms(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation | null>, v: View) {
  gl.uniform4f(u.uView!, v.sx, v.sy, v.vw, v.vh);
  gl.uniform3f(u.uShake!, v.shakeX, v.shakeY, v.dpr);
}

const BATCH_VS = `#version 300 es
in vec2 aPos;
in vec4 aColor;
in float aAcross;
uniform vec4 uView;
uniform vec3 uShake;
uniform vec3 uPersp; // centre x, y (page px), scale: p' = c + (p - c) * k (the hole's far side)
uniform vec2 uOffset;
out vec4 vColor;
out float vAcross;
void main() {
  vec2 p = uPersp.xy + (aPos - uPersp.xy) * uPersp.z + uOffset + uShake.xy;
  vec2 c = (p - uView.xy) / uView.zw;
  gl_Position = vec4(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
  vColor = aColor;
  vAcross = aAcross;
}`;
const BATCH_FS = `#version 300 es
precision mediump float;
in vec4 vColor;
in float vAcross;
out vec4 outColor;
void main() {
  // lines carry -1..1 across their width: a one-pixel antialiased edge; fills carry 0
  float a = clamp((1.0 - abs(vAcross)) / max(fwidth(vAcross), 1e-4), 0.0, 1.0);
  outColor = vec4(vColor.rgb * vColor.a * a, vColor.a * a);
}`;

const STRIDE = 7;

/**
 * Coloured triangles in page px, premultiplied alpha. Push shapes, then draw(). Lines are quads one pixel wider than
 * asked on each side, faded by their across coordinate, so hairlines stay smooth at any scale.
 */
export class Batch {
  private data = new Float32Array(STRIDE * 4096);
  private n = 0;
  private vao: WebGLVertexArrayObject;
  private buf: WebGLBuffer;
  readonly program: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null>;

  constructor(private gl: WebGL2RenderingContext) {
    this.program = compile(gl, BATCH_VS, BATCH_FS);
    this.u = uniforms(gl, this.program, ["uView", "uShake", "uPersp", "uOffset"]);
    this.vao = gl.createVertexArray()!;
    this.buf = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const attr = (name: string, size: number, off: number) => {
      const loc = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, off * 4);
    };
    attr("aPos", 2, 0);
    attr("aColor", 4, 2);
    attr("aAcross", 1, 6);
    gl.bindVertexArray(null);
  }

  get empty() {
    return this.n === 0;
  }

  private room(k: number) {
    if ((this.n + k) * STRIDE <= this.data.length) return;
    const d = new Float32Array(Math.max(this.data.length * 2, (this.n + k) * STRIDE));
    d.set(this.data);
    this.data = d;
  }

  vert(x: number, y: number, r: number, g: number, b: number, a: number, across = 0) {
    this.room(1);
    const o = this.n++ * STRIDE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = r;
    d[o + 3] = g;
    d[o + 4] = b;
    d[o + 5] = a;
    d[o + 6] = across;
  }

  /** A filled polygon given as flat xy points and triangle indices into them, moved by (dx, dy). */
  poly(pts: ArrayLike<number>, tris: ArrayLike<number>, c: readonly number[], dx = 0, dy = 0) {
    for (let i = 0; i < tris.length; i++) {
      const k = tris[i]! * 2;
      this.vert(pts[k]! + dx, pts[k + 1]! + dy, c[0]!, c[1]!, c[2]!, c[3]!);
    }
  }

  /** A line segment of width w (px). */
  line(x0: number, y0: number, x1: number, y1: number, w: number, c: readonly number[]) {
    let nx = y0 - y1;
    let ny = x1 - x0;
    const l = Math.hypot(nx, ny) || 1;
    const h = w / 2 + 1;
    nx = (nx / l) * h;
    ny = (ny / l) * h;
    // the across coordinate reaches 1 a pixel past the asked width
    const e = h / (h - 0.5);
    const [r, g, b, a] = c as [number, number, number, number];
    this.vert(x0 + nx, y0 + ny, r, g, b, a, e);
    this.vert(x0 - nx, y0 - ny, r, g, b, a, -e);
    this.vert(x1 + nx, y1 + ny, r, g, b, a, e);
    this.vert(x1 + nx, y1 + ny, r, g, b, a, e);
    this.vert(x0 - nx, y0 - ny, r, g, b, a, -e);
    this.vert(x1 - nx, y1 - ny, r, g, b, a, -e);
  }

  /** Draw what's been pushed and empty the batch. */
  draw(v: View, opts: { persp?: [number, number, number]; offset?: [number, number] } = {}) {
    if (this.n === 0) return;
    this.drawKeep(v, opts);
    this.n = 0;
  }

  /** Draw what's been pushed and keep it (to draw it again, e.g. once into the stencil and once in colour). */
  drawKeep(v: View, opts: { persp?: [number, number, number]; offset?: [number, number] } = {}) {
    const gl = this.gl;
    if (this.n === 0) return;
    gl.useProgram(this.program);
    setViewUniforms(gl, this.u, v);
    const p = opts.persp ?? [0, 0, 1];
    gl.uniform3f(this.u.uPersp!, p[0], p[1], p[2]);
    const o = opts.offset ?? [0, 0];
    gl.uniform2f(this.u.uOffset!, o[0], o[1]);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.n * STRIDE), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, this.n);
    gl.bindVertexArray(null);
  }

  clear() {
    this.n = 0;
  }
}

/** Ear-clipping triangulation of a simple polygon (flat xy), as indices. Good enough for crack-bounded fragments. */
export function triangulate(pts: ArrayLike<number>): number[] {
  const n = pts.length / 2;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i * 2]! * pts[j * 2 + 1]! - pts[j * 2]! * pts[i * 2 + 1]!;
  }
  if (area < 0) idx.reverse();
  const out: number[] = [];
  const x = (i: number) => pts[i * 2]!;
  const y = (i: number) => pts[i * 2 + 1]!;
  const cross = (a: number, b: number, c: number) => (x(b) - x(a)) * (y(c) - y(a)) - (y(b) - y(a)) * (x(c) - x(a));
  const inside = (p: number, a: number, b: number, c: number) =>
    cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length]!;
      const b = idx[i]!;
      const c = idx[(i + 1) % idx.length]!;
      if (cross(a, b, c) <= 0) continue;
      let ok = true;
      for (const p of idx) {
        if (p === a || p === b || p === c) continue;
        if (inside(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      cut = true;
      break;
    }
    // (a self-touching outline: no clean ear left; cut the most convex corner anyway)
    if (!cut) {
      let best = -1;
      let bc = -Infinity;
      for (let i = 0; i < idx.length; i++) {
        const c = cross(idx[(i + idx.length - 1) % idx.length]!, idx[i]!, idx[(i + 1) % idx.length]!);
        if (c > bc) {
          bc = c;
          best = i;
        }
      }
      out.push(idx[(best + idx.length - 1) % idx.length]!, idx[best]!, idx[(best + 1) % idx.length]!);
      idx.splice(best, 1);
    }
  }
  if (idx.length === 3) out.push(idx[0]!, idx[1]!, idx[2]!);
  return out;
}
