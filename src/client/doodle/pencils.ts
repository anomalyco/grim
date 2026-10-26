// 3D pencils in one WebGL2 canvas over the page: a sharpened hexagonal pencil (paint, wood, lead in the paint
// colour, metal ferrule, eraser), lightly cel-shaded with a thin outline and a soft shadow on the paper.
// Hand-rolled instead of three.js: the scene is one small mesh drawn a few times, which is ~10 KB of code here
// against ~130 KB gzipped for three.js.

export interface PencilPose {
  /** tip, in viewport CSS px; z is the height above the paper */
  x: number;
  y: number;
  z: number;
  /** the pencil's direction from the tip toward the eraser (any length; z must be > 0) */
  ax: number;
  ay: number;
  az: number;
  roll: number;
  scale: number;
  color: [number, number, number];
}

/** pencil length in px at scale 1 */
export const PENCIL_LENGTH = 197;
const R = 7; // hexagon circumradius
const CONE_END = 30;
const BODY_END = 168;
const LEAD_R = 1.9;
const coneR = (y: number) => 0.3 + (y * (R - 0.3)) / (CONE_END - 3);

// Toward the light: from above and a little to the left (page y grows downward, z toward the viewer).
const L = norm([-0.3, -0.55, 1]);

const VS = `#version 300 es
uniform mat4 u_model;
uniform vec3 u_cam;
uniform vec2 u_view;
uniform float u_outline;
in vec3 a_pos;
in vec3 a_nrm;
in vec3 a_snrm;
in vec3 a_mat;
out vec3 v_n;
out vec3 v_w;
out vec3 v_mat;
void main() {
  vec3 w = (u_model * vec4(a_pos, 1.0)).xyz;
  v_n = normalize(mat3(u_model) * a_nrm);
  if (u_outline > 0.0) w += normalize(mat3(u_model) * a_snrm) * u_outline;
  v_w = w;
  v_mat = a_mat;
  float dz = u_cam.z - w.z;
  gl_Position = vec4((w.x - u_cam.x) * u_cam.z / (u_view.x * 0.5), -(w.y - u_cam.y) * u_cam.z / (u_view.y * 0.5), (0.5 - w.z / 4000.0) * dz, dz);
}`;

const FS = `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform vec3 u_cam;
uniform vec3 u_light;
uniform float u_outline;
in vec3 v_n;
in vec3 v_w;
in vec3 v_mat;
out vec4 o;
void main() {
  if (u_outline > 0.0) { o = vec4(mix(u_color, vec3(0.06, 0.06, 0.08), 0.72), 1.0); return; }
  vec3 n = normalize(v_n);
  vec3 V = normalize(u_cam - v_w);
  float d = dot(n, u_light);
  float spec = max(dot(reflect(-u_light, n), V), 0.0);
  vec3 base;
  float gloss = 0.0;
  if (v_mat.x < 0.5) {
    if (v_mat.y > 0.0) { base = u_color; gloss = smoothstep(0.9, 0.96, spec) * 0.16; }
    else if (v_mat.z < ${LEAD_R.toFixed(2)}) { base = mix(u_color, vec3(0.13, 0.13, 0.15), 0.45); gloss = smoothstep(0.85, 0.95, spec) * 0.18; }
    else base = vec3(0.89, 0.74, 0.55) * (0.94 + 0.06 * sin(v_mat.z * 9.0));
  } else if (v_mat.x < 1.5) { base = vec3(0.72, 0.71, 0.68); gloss = smoothstep(0.7, 0.8, spec) * 0.45; }
  else base = vec3(0.86, 0.66, 0.62);
  // a few soft tone bands, not a hard cartoon step
  float lit = 0.58 + 0.24 * smoothstep(-0.2, 0.15, d) + 0.18 * smoothstep(0.5, 0.68, d);
  vec3 c = base * lit + gloss;
  float rim = smoothstep(0.6, 0.95, 1.0 - max(dot(n, V), 0.0));
  c += rim * 0.12 * vec3(0.95, 0.97, 1.0);
  o = vec4(c, 1.0);
}`;

const SHADOW_VS = `#version 300 es
uniform vec2 u_view;
in vec2 a_xy;
out vec2 v_xy;
void main() {
  v_xy = a_xy;
  gl_Position = vec4(a_xy.x / u_view.x * 2.0 - 1.0, 1.0 - a_xy.y / u_view.y * 2.0, 0.99, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision highp float;
uniform vec4 u_seg;
uniform vec4 u_shape;
in vec2 v_xy;
out vec4 o;
void main() {
  vec2 a = u_seg.xy;
  vec2 b = u_seg.zw;
  vec2 ab = b - a;
  float t = clamp(dot(v_xy - a, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
  float d = length(v_xy - (a + ab * t));
  float r = mix(u_shape.x, u_shape.y, t);
  float blur = mix(u_shape.z, u_shape.z + 6.0, t);
  float k = (1.0 - smoothstep(r - blur, r + blur, d)) * u_shape.w * mix(1.0, 0.5, t);
  o = vec4(0.1, 0.1, 0.14, 1.0) * k;
}`;

function norm(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

/** The pencil mesh: interleaved pos(3) normal(3) smoothNormal(3) material(3), triangles. */
function buildMesh(): Float32Array {
  const out: number[] = [];
  type V = [number[], number[], number[], number[]];
  const quad = (a: V, b: V, c: V, d: V) => {
    for (const v of [a, b, c, a, c, d]) out.push(...v[0], ...v[1], ...v[2], ...v[3]);
  };
  // sharpened hexagonal body: the hexagonal prism cut by the sharpening cone
  const rings: number[] = [];
  for (let y = 0; y < 3; y += 0.5) rings.push(y);
  for (let y = 3; y < CONE_END + 1; y += 1) rings.push(y);
  rings.push(BODY_END);
  const K = 6;
  for (let f = 0; f < 6; f++) {
    const a0 = (f * Math.PI) / 3 + Math.PI / 6;
    const a1 = ((f + 1) * Math.PI) / 3 + Math.PI / 6;
    const c0 = [Math.cos(a0) * R, Math.sin(a0) * R];
    const c1 = [Math.cos(a1) * R, Math.sin(a1) * R];
    const fn = norm([Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)]);
    const vert = (j: number, y: number): V => {
      const qx = c0[0]! + ((c1[0]! - c0[0]!) * j) / K;
      const qz = c0[1]! + ((c1[1]! - c0[1]!) * j) / K;
      const rq = Math.hypot(qx, qz);
      const rc = coneR(y);
      const dir = [qx / rq, 0, qz / rq];
      if (rc >= rq) return [[qx, y, qz], fn, dir, [0, rc - rq, rc]];
      const k = (R - 0.3) / (CONE_END - 3);
      const n = norm([dir[0]!, -k, dir[2]!]);
      return [[dir[0]! * rc, y, dir[2]! * rc], n, dir, [0, rc - rq, rc]];
    };
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < K; j++) quad(vert(j, rings[i]!), vert(j + 1, rings[i]!), vert(j + 1, rings[i + 1]!), vert(j, rings[i + 1]!));
    }
  }
  // ferrule and eraser: lathed profiles [y, r]
  const lathe = (profile: number[][], mat: number, segs = 28) => {
    for (let i = 0; i < profile.length - 1; i++) {
      const [y0, r0] = profile[i]!;
      const [y1, r1] = profile[i + 1]!;
      const dy = y1! - y0!;
      const dr = r1! - r0!;
      for (let s = 0; s < segs; s++) {
        const v = (k: number, y: number, r: number): V => {
          const a = (k / segs) * Math.PI * 2;
          const dir = [Math.cos(a), 0, Math.sin(a)];
          const n = norm([dir[0]! * dy, -dr, dir[2]! * dy]);
          return [[dir[0]! * r, y, dir[2]! * r], n, r < 0.5 ? [0, 1, 0] : dir, [mat, 0, 0]];
        };
        quad(v(s, y0!, r0!), v(s + 1, y0!, r0!), v(s + 1, y1!, r1!), v(s, y1!, r1!));
      }
    }
  };
  const F = BODY_END;
  lathe([[F - 0.5, 6.6], [F, 7.25], [F + 2, 7.3], [F + 2.6, 7.0], [F + 3.4, 7.0], [F + 4, 7.3], [F + 9, 7.3], [F + 9.6, 7.0], [F + 10.4, 7.0], [F + 11, 7.3], [F + 15.5, 7.3], [F + 16, 6.9]], 1);
  const E = F + 16;
  lathe([[E - 0.2, 6.5], [E + 10, 6.5], [E + 11.5, 6.1], [E + 12.5, 5.2], [E + 13, 3.6], [E + 13.2, 0]], 2);
  return new Float32Array(out);
}

export class PencilRenderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private shadowProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private shadowVao: WebGLVertexArrayObject;
  private shadowBuf: WebGLBuffer;
  private count: number;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private su: Record<string, WebGLUniformLocation | null> = {};
  private w = 1;
  private h = 1;

  static create(canvas: HTMLCanvasElement): PencilRenderer | null {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: "low-power" });
    if (!gl) return null;
    try {
      return new PencilRenderer(gl);
    } catch (e) {
      console.warn("pencils: WebGL setup failed", e);
      return null;
    }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = program(gl, VS, FS);
    this.shadowProg = program(gl, SHADOW_VS, SHADOW_FS);
    for (const n of ["u_model", "u_cam", "u_view", "u_outline", "u_color", "u_light"]) this.u[n] = gl.getUniformLocation(this.prog, n);
    for (const n of ["u_view", "u_seg", "u_shape"]) this.su[n] = gl.getUniformLocation(this.shadowProg, n);
    const mesh = buildMesh();
    this.count = mesh.length / 12;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
    ["a_pos", "a_nrm", "a_snrm", "a_mat"].forEach((name, i) => {
      const loc = gl.getAttribLocation(this.prog, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 48, i * 12);
    });
    this.shadowVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.shadowVao);
    this.shadowBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
    const sloc = gl.getAttribLocation(this.shadowProg, "a_xy");
    gl.enableVertexAttribArray(sloc);
    gl.vertexAttribPointer(sloc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  resize(w: number, h: number, dpr: number) {
    const c = this.gl.canvas as HTMLCanvasElement;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    this.w = w;
    this.h = h;
  }

  render(poses: PencilPose[]) {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!poses.length) return;
    const cam = [this.w / 2, this.h / 2, 1600];

    // shadows on the paper
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.shadowProg);
    gl.uniform2f(this.su.u_view!, this.w, this.h);
    gl.bindVertexArray(this.shadowVao);
    const kx = -L[0] / L[2];
    const ky = -L[1] / L[2];
    for (const p of poses) {
      const len = PENCIL_LENGTH * p.scale;
      const al = Math.hypot(p.ax, p.ay, p.az);
      const ex = p.x + (p.ax / al) * len;
      const ey = p.y + (p.ay / al) * len;
      const ez = p.z + (p.az / al) * len;
      const s0x = p.x + p.z * kx;
      const s0y = p.y + p.z * ky;
      const s1x = ex + ez * kx;
      const s1y = ey + ez * ky;
      const r0 = 2.5 * p.scale + p.z * 0.04;
      const r1 = 8 * p.scale;
      const blur = Math.min(30, 1.5 + p.z * 0.08);
      const pad = Math.max(r0, r1) + blur + 8;
      const x0 = Math.min(s0x, s1x) - pad;
      const x1 = Math.max(s0x, s1x) + pad;
      const y0 = Math.min(s0y, s1y) - pad;
      const y1 = Math.max(s0y, s1y) + pad;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1]), gl.STREAM_DRAW);
      gl.uniform4f(this.su.u_seg!, s0x, s0y, s1x, s1y);
      gl.uniform4f(this.su.u_shape!, r0, r1, blur, Math.max(0.04, 0.13 - p.z * 0.0008));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // pencils: outline (inverted hull), then the pencil
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform3f(this.u.u_cam!, cam[0]!, cam[1]!, cam[2]!);
    gl.uniform2f(this.u.u_view!, this.w, this.h);
    gl.uniform3f(this.u.u_light!, L[0], L[1], L[2]);
    gl.enable(gl.CULL_FACE);
    for (const p of poses) {
      gl.uniformMatrix4fv(this.u.u_model!, false, modelMatrix(p));
      gl.uniform3f(this.u.u_color!, p.color[0], p.color[1], p.color[2]);
      gl.cullFace(gl.FRONT);
      gl.uniform1f(this.u.u_outline!, 0.9);
      gl.drawArrays(gl.TRIANGLES, 0, this.count);
      gl.cullFace(gl.BACK);
      gl.uniform1f(this.u.u_outline!, 0);
      gl.drawArrays(gl.TRIANGLES, 0, this.count);
    }
    gl.bindVertexArray(null);
  }
}

function modelMatrix(p: PencilPose): Float32Array {
  const a = norm([p.ax, p.ay, p.az]);
  let x0 = norm([a[1], -a[0], 0]);
  if (!Number.isFinite(x0[0]) || Math.hypot(a[0], a[1]) < 1e-4) x0 = [1, 0, 0];
  const z0 = [x0[1] * a[2] - x0[2] * a[1], x0[2] * a[0] - x0[0] * a[2], x0[0] * a[1] - x0[1] * a[0]];
  const c = Math.cos(p.roll);
  const s = Math.sin(p.roll);
  const X = [x0[0] * c + z0[0]! * s, x0[1] * c + z0[1]! * s, x0[2] * c + z0[2]! * s];
  const Z = [-x0[0] * s + z0[0]! * c, -x0[1] * s + z0[1]! * c, -x0[2] * s + z0[2]! * c];
  const k = p.scale;
  // column-major
  return new Float32Array([X[0]! * k, X[1]! * k, X[2]! * k, 0, a[0] * k, a[1] * k, a[2] * k, 0, Z[0]! * k, Z[1]! * k, Z[2]! * k, 0, p.x, p.y, p.z, 1]);
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader error");
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link error");
  return p;
}
