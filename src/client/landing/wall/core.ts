// Shared plumbing for the wall: the view (scroll and window, in page px), random helpers, small WebGL2 helpers, a
// growable float buffer, 3×3 rotations, and triangulation. No parameters to tune here: each piece keeps its own at
// the top of its module.

/** Where the window is on the page, in CSS px, and the canvas resolution. Updated once per frame by index.ts. */
export interface View {
  sx: number;
  sy: number;
  vw: number;
  vh: number;
  dpr: number;
  /** the page jolt (px), added to everything the wall draws */
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

/** A tiny deterministic random source, so a crack edge shared by two plates jags the same way for both. */
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

/** A growable array of floats (a vertex stream rebuilt when something moves). */
export class Buf {
  data: Float32Array;
  n = 0;
  constructor(size = 4096) {
    this.data = new Float32Array(size);
  }
  room(k: number) {
    if (this.n + k <= this.data.length) return;
    const d = new Float32Array(Math.max(this.data.length * 2, this.n + k));
    d.set(this.data.subarray(0, this.n));
    this.data = d;
  }
  clear() {
    this.n = 0;
  }
}

/** A rigid transform: world = R · p + t (R row-major 3×3). */
export interface Xf {
  r: Float64Array | number[];
  t: [number, number, number];
}

export const IDENTITY: Xf = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/** Rotation by `angle` (rad) about the unit axis (x, y, z). */
export function axisAngle(x: number, y: number, z: number, angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  return [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
}

export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const o: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return o;
}

/** Keep a rotation a rotation (Gram–Schmidt on the rows), after many small steps. */
export function orthonormalize(r: number[]) {
  let [a0, a1, a2, b0, b1, b2] = r as [number, number, number, number, number, number];
  const n0 = Math.hypot(a0, a1, a2);
  a0 /= n0;
  a1 /= n0;
  a2 /= n0;
  const d = a0 * b0 + a1 * b1 + a2 * b2;
  b0 -= d * a0;
  b1 -= d * a1;
  b2 -= d * a2;
  const n1 = Math.hypot(b0, b1, b2);
  b0 /= n1;
  b1 /= n1;
  b2 /= n1;
  r.splice(0, 9, a0, a1, a2, b0, b1, b2, a1 * b2 - a2 * b1, a2 * b0 - a0 * b2, a0 * b1 - a1 * b0);
}

/** Ear-clipping triangulation of a simple polygon (flat xy), as indices. Good enough for crack-bounded plates. */
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
