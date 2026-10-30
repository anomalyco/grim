// The hole: where fragments have broken out (cracks.ts's removed cells), the wall is open onto a dark space. The
// opening is drawn twice into the stencil: as it is (the front face of the wall) and as its far side, pulled toward
// the middle of the window by the board's thickness (simple perspective, so it shifts as you scroll). Through both:
// the dark. In the front but not the back: the broken edge's thickness, lit by the key light. Along the outline, a
// bright lip and a dark seam; round it, the board bulges out where it was pushed from behind.
import { compile, FULLSCREEN_VS, PAGE_POS_GLSL, setViewUniforms, uniforms, type Batch, type View } from "./core.ts";
import type { Cell, Fracture } from "./cracks.ts";
import type { Material } from "./material.ts";
import { MATERIAL } from "./material.ts";

export const HOLE = {
  /** the board's thickness, as how far the far side of the opening pulls toward the window's middle */
  depth: 0.035,
  /** and a fixed pull (px), so the thickness shows even straight on: right, down */
  tilt: [2, 4] as const,
  /** the dark behind: colour at the middle and at the edges of the opening */
  darkCentre: [0.085, 0.075, 0.08],
  darkEdge: [0.01, 0.008, 0.012],
  /** the faint movement in the dark: strength and speed */
  stir: 0.03,
  stirSpeed: 0.08,
  /** something big passing behind now and then (never seen, just the dark shifting): strength */
  passing: 0.03,
  /** the broken edge: its shade in light and in shadow (fractions of the paper colour) */
  edgeLit: 0.95,
  edgeDark: 0.52,
  /** the broken gypsum's colour */
  gypsum: [0.9, 0.875, 0.83] as const,
  /** the lip along the opening: highlight width and alpha, seam width and alpha */
  lip: [1.4, 0.95] as const,
  seam: [1.1, 0.7] as const,
  /** the board bulging out round a break: px of height and radius (px) */
  bulge: 2.2,
  bulgeRadius: 16,
};

const DARK_FS = `#version 300 es
precision highp float;
${PAGE_POS_GLSL}
uniform vec3 uHole;      // centre x, y, radius
uniform float uTime;
uniform vec3 uCentre;
uniform vec3 uEdge;
uniform vec3 uStir;      // stir, speed, passing
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 p = pagePos();
  float d = distance(p, uHole.xy) / max(uHole.z, 1.0);
  vec3 col = mix(uCentre, uEdge, smoothstep(0.1, 1.1, d));
  float t = uTime * uStir.y;
  float n = noise(p / 90.0 + vec2(t, -t * 0.7)) * 0.6 + noise(p / 31.0 - vec2(t * 1.7, t)) * 0.4;
  col += (n - 0.5) * uStir.x;
  // a slow, huge shape drifting across behind the opening
  vec2 q = (p - uHole.xy) / max(uHole.z, 1.0);
  float pass = exp(-pow(q.x - sin(uTime * 0.13) * 1.4, 2.0) * 2.5) * (0.5 + 0.5 * sin(uTime * 0.31 + q.y * 2.0));
  col -= pass * uStir.z;
  outColor = vec4(max(col, 0.0), 1.0);
}`;

const EDGE_FS = `#version 300 es
precision highp float;
${PAGE_POS_GLSL}
uniform vec3 uHole;
uniform vec3 uLight;
uniform vec3 uBase;
uniform vec2 uShade;     // lit, dark
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = pagePos();
  // the broken face looks in toward the opening's middle
  vec2 n = normalize(uHole.xy - p + vec2(1e-3));
  float lit = clamp(dot(n, normalize(uLight.xy)) * 0.5 + 0.5, 0.0, 1.0);
  float s = mix(uShade.y, uShade.x, lit);
  // crumbly gypsum: coarse grain, and pits
  vec2 g = vec2(dot(p, n), dot(p, vec2(-n.y, n.x)));
  s *= 0.9 + 0.14 * hash(floor(g * vec2(0.6, 0.35)));
  s *= 0.96 + 0.06 * hash(floor(p * 0.9));
  outColor = vec4(uBase * s, 1.0);
}`;

export class Hole {
  private dark: WebGLProgram;
  private edge: WebGLProgram;
  private ud: Record<string, WebGLUniformLocation | null>;
  private ue: Record<string, WebGLUniformLocation | null>;
  private time = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    private fracture: Fracture,
    private material: Material,
  ) {
    this.dark = compile(gl, FULLSCREEN_VS, DARK_FS);
    this.edge = compile(gl, FULLSCREEN_VS, EDGE_FS);
    this.ud = uniforms(gl, this.dark, ["uView", "uShake", "uHole", "uTime", "uCentre", "uEdge", "uStir"]);
    this.ue = uniforms(gl, this.edge, ["uView", "uShake", "uHole", "uLight", "uBase", "uShade"]);
  }

  /** A plate broke out: the board round it buckles outward. */
  opened(c: Cell) {
    const f = this.fracture;
    const r = HOLE.bulgeRadius;
    for (const e of c.edges) {
      const ed = f.edges[e]!;
      const other = ed.cells.find((o) => o !== c.id);
      if (other === undefined || f.cells[other]!.removed) continue;
      for (let i = 0; i < ed.pts.length; i += 4) {
        const x = ed.pts[i]!;
        const y = ed.pts[i + 1]!;
        const k = HOLE.bulge * (0.6 + Math.random() * 0.8);
        this.material.stamp(x - r * 2, y - r * 2, x + r * 2, y + r * 2, (px, py) => k * Math.exp(-((px - x) ** 2 + (py - y) ** 2) / (r * r)));
      }
    }
  }

  /** The opening's middle and size (px). */
  extent(): [number, number, number] {
    const cells = this.fracture.removed;
    if (!cells.length) return [this.fracture.cx, this.fracture.cy, 0];
    let x = 0;
    let y = 0;
    for (const c of cells) {
      x += c.cx;
      y += c.cy;
    }
    x /= cells.length;
    y /= cells.length;
    let r = 0;
    for (const c of cells) r = Math.max(r, Math.hypot(c.cx - x, c.cy - y) + 40);
    return [x, y, r];
  }

  update(dt: number) {
    this.time += dt;
  }

  draw(b: Batch, v: View) {
    const cells = this.fracture.removed;
    if (!cells.length) return;
    const gl = this.gl;
    // fans with INVERT: the even-odd rule fills each outline exactly, however jagged (the fragments don't overlap)
    for (const c of cells) b.poly(c.poly, c.fan, [0, 0, 0, 1]);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilMask(1);
    b.drawKeep(v);
    gl.stencilMask(2);
    b.drawKeep(v, { persp: [v.sx + v.vw / 2, v.sy + v.vh / 2, 1 - HOLE.depth], offset: [HOLE.tilt[0], HOLE.tilt[1]] });
    b.clear();
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0);
    const [hx, hy, hr] = this.extent();

    gl.disable(gl.BLEND);
    gl.stencilFunc(gl.EQUAL, 3, 3);
    gl.useProgram(this.dark);
    setViewUniforms(gl, this.ud, v);
    gl.uniform3f(this.ud.uHole!, hx, hy, hr);
    gl.uniform1f(this.ud.uTime!, this.time);
    gl.uniform3fv(this.ud.uCentre!, HOLE.darkCentre);
    gl.uniform3fv(this.ud.uEdge!, HOLE.darkEdge);
    gl.uniform3f(this.ud.uStir!, HOLE.stir, HOLE.stirSpeed, HOLE.passing);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.stencilFunc(gl.EQUAL, 1, 3);
    gl.useProgram(this.edge);
    setViewUniforms(gl, this.ue, v);
    gl.uniform3f(this.ue.uHole!, hx, hy, hr);
    gl.uniform3fv(this.ue.uLight!, MATERIAL.light);
    gl.uniform3fv(this.ue.uBase!, HOLE.gypsum);
    gl.uniform2f(this.ue.uShade!, HOLE.edgeLit, HOLE.edgeDark);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);

    // the lip: a bright line on the wall's side of the outline, a dark seam right on it
    const lip = [1, 1, 1, HOLE.lip[1]];
    const seam = [0.2, 0.19, 0.2, HOLE.seam[1]];
    for (const [ed, cell] of this.fracture.rim()) {
      const p = ed.pts;
      for (let i = 2; i < p.length; i += 2) {
        const x0 = p[i - 2]!;
        const y0 = p[i - 1]!;
        const x1 = p[i]!;
        const y1 = p[i + 1]!;
        let nx = (x0 + x1) / 2 - cell.cx;
        let ny = (y0 + y1) / 2 - cell.cy;
        const l = Math.hypot(nx, ny) || 1;
        nx = (nx / l) * 1.2;
        ny = (ny / l) * 1.2;
        b.line(x0 + nx, y0 + ny, x1 + nx, y1 + ny, HOLE.lip[0], lip);
        b.line(x0, y0, x1, y1, HOLE.seam[0], seam);
      }
    }
  }
}
