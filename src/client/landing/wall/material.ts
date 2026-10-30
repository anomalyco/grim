// The wall material: the page's background as matte white drywall, painted. A full-window WebGL pass shades a
// height field (page px, over the hero: where anything is ever punched) under a soft key light from the top left. At rest
// the field is flat and the shading is exactly the paper colour, plus a faint gloss gradient and grain; dents and
// bulges (stamped by punches.ts) and passing flex waves (wave()) catch the light. Heights are in px toward the viewer.
import { compile, FULLSCREEN_VS, PAGE_POS_GLSL, setViewUniforms, uniforms, type View } from "./core.ts";

export const MATERIAL = {
  /** height-field cell size (CSS px): smaller is sharper and slower */
  cell: 3,
  cellLow: 6,
  /** the canvas never renders above this device pixel ratio */
  dprCap: 1.5,
  dprCapLow: 1,
  /** the paper colour (app.css --paper), what a flat wall shades to */
  base: [0xfc / 255, 0xfc / 255, 0xfb / 255],
  /** the key light, pointing from the surface to the light (x right, y down, z toward you) */
  light: [-0.45, -0.62, 0.64],
  /** how much a surface tilted away from the light darkens, and how much one tilted toward it brightens (it's white
   *  already: dents read mostly by their shadows) */
  diffuse: 1.5,
  brighten: 0.3,
  /** concave creases darken (a cheap ambient occlusion): strength */
  occlusion: 0.9,
  /** sheen of the paint: strength and tightness (matte: barely any) */
  specular: 0.025,
  shininess: 10,
  /** height (px) to slope: higher exaggerates every dent */
  relief: 1.0,
  /** the resting look: a soft light falloff across the window, and the paint's grain (fractions of the colour) */
  sheen: 0.012,
  grain: 0.004,
  /** flex waves from a punch: speed (px/s), wavelength (px), how fast they die (1/s), and the bend at the impact */
  waveSpeed: 700,
  waveLength: 120,
  waveDecay: 2.2,
  flexRadius: 240,
  flexFreq: 11,
  flexDecay: 6,
  maxWaves: 8,
  /** the page shake on a punch: px and seconds */
  shake: 2.2,
  shakeTime: 0.28,
};

const FS = `#version 300 es
precision highp float;
${PAGE_POS_GLSL}
uniform sampler2D uHeight;
uniform vec4 uField;      // field origin x, y (page px), size w, h (page px)
uniform vec4 uWaves[${MATERIAL.maxWaves}]; // x, y, age (s), amplitude (px)
uniform vec3 uBase;
uniform vec3 uLight;
uniform vec4 uShade;      // diffuse, specular, shininess, relief
uniform vec4 uWave;       // speed, wavelength, decay, flex radius
uniform vec3 uFlex;       // flex freq (Hz), flex decay, cell
uniform vec4 uRest;       // sheen, grain, brighten, occlusion
out vec4 outColor;

float field(vec2 p) {
  vec2 uv = (p - uField.xy) / uField.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture(uHeight, uv).r;
}

float waves(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < ${MATERIAL.maxWaves}; i++) {
    vec4 w = uWaves[i];
    if (w.w == 0.0) continue;
    float r = distance(p, w.xy);
    float front = r - uWave.x * w.z;
    // a ring packet running outward
    float ring = sin(front / uWave.y * 6.2832) * exp(-front * front / (uWave.y * uWave.y * 1.2));
    h += w.w * 0.35 * ring * exp(-w.z * uWave.z) / (1.0 + r / 400.0);
    // the whole wall bending in at the impact and springing back
    h -= w.w * exp(-r * r / (uWave.w * uWave.w)) * cos(w.z * uFlex.x * 6.2832) * exp(-w.z * uFlex.y);
  }
  return h;
}


float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 p = pagePos();
  float e = uFlex.z;
  // the field: central differences and its creases; the waves (costlier, smooth): one-sided, three points
  float f0 = field(p);
  float fx = field(p + vec2(e, 0.0));
  float fy = field(p + vec2(0.0, e));
  float fx0 = field(p - vec2(e, 0.0));
  float fy0 = field(p - vec2(0.0, e));
  float w0 = 0.0, wx = 0.0, wy = 0.0;
  if (uWaves[0].w != 0.0) {
    w0 = waves(p);
    wx = waves(p + vec2(e, 0.0)) - w0;
    wy = waves(p + vec2(0.0, e)) - w0;
  }
  float h0 = f0 + w0;
  float dx = (fx - fx0) / (2.0 * e) + wx / e;
  float dy = (fy - fy0) / (2.0 * e) + wy / e;
  vec3 n = normalize(vec3(-dx * uShade.w, -dy * uShade.w, 1.0));
  float lap = (fx + fx0 + fy + fy0 - 4.0 * f0) / (e * e);
  vec3 l = normalize(uLight);
  vec3 hv = normalize(l + vec3(0.0, 0.0, 1.0));
  // relative to a flat wall, so at rest it's exactly the paper
  float diff = max(dot(n, l), 0.0) - l.z;
  diff *= diff > 0.0 ? uRest.z : uShade.x;
  float occ = clamp(lap * uRest.w, 0.0, 0.18);
  float spec = (pow(max(dot(n, hv), 0.0), uShade.z) - pow(hv.z, uShade.z)) * uShade.y;
  // (no tint by height: paint is paint)
  float depth = 0.0;
  vec2 c = (p - uView.xy) / uView.zw;
  float rest = uRest.x * (0.5 - length(c - vec2(0.25, 0.1))) + uRest.y * (hash(floor(p)) - 0.5);
  vec3 col = uBase * (1.0 + diff + rest - depth - occ) + vec3(spec);
  outColor = vec4(col, 1.0);
}`;

interface Wave {
  x: number;
  y: number;
  t: number;
  amp: number;
}

/** The wall: its height field, the waves running through it, and the shake. */
export class Material {
  readonly cell: number;
  /** the field covers page px [x0, x0 + gw * cell) × [y0, y0 + gh * cell) */
  gw = 0;
  gh = 0;
  x0 = 0;
  y0 = 0;
  h = new Float32Array(0);
  private dirty: [number, number, number, number] | null = null;
  private tex: WebGLTexture;
  private program: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null>;
  private waveList: Wave[] = [];
  private shakeT = 9;
  private shakeAmp = 0;
  private time = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    low: boolean,
  ) {
    this.cell = low ? MATERIAL.cellLow : MATERIAL.cell;
    this.program = compile(gl, FULLSCREEN_VS, FS);
    this.u = uniforms(gl, this.program, [
      "uView", "uShake", "uHeight", "uField", "uWaves", "uBase", "uLight", "uShade", "uWave", "uFlex", "uRest",
    ]);
    this.tex = gl.createTexture()!;
  }

  /** (Re)size the field to cover page px w × h; keeps nothing (the caller re-stamps). */
  resize(w: number, h: number) {
    const gl = this.gl;
    this.gw = Math.max(2, Math.ceil(w / this.cell) + 1);
    this.gh = Math.max(2, Math.ceil(h / this.cell) + 1);
    this.h = new Float32Array(this.gw * this.gh);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, this.gw, this.gh, 0, gl.RED, gl.FLOAT, this.h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.dirty = null;
  }

  /**
   * Add f(x, y) (page px → px of height) to the field over the page box [x0, x1] × [y0, y1], scaled by k. punches.ts
   * and hole.ts shape the wall with this.
   */
  stamp(bx0: number, by0: number, bx1: number, by1: number, f: (x: number, y: number) => number, k = 1) {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((bx0 - this.x0) / c));
    const j0 = Math.max(0, Math.floor((by0 - this.y0) / c));
    const i1 = Math.min(this.gw - 1, Math.ceil((bx1 - this.x0) / c));
    const j1 = Math.min(this.gh - 1, Math.ceil((by1 - this.y0) / c));
    if (i1 < i0 || j1 < j0) return;
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + j * c;
      for (let i = i0; i <= i1; i++) {
        const v = f(this.x0 + i * c, y);
        if (v !== 0) this.h[j * this.gw + i]! += v * k;
      }
    }
    const d = this.dirty;
    this.dirty = d ? [Math.min(d[0], i0), Math.min(d[1], j0), Math.max(d[2], i1), Math.max(d[3], j1)] : [i0, j0, i1, j1];
  }

  /** The field's slope at page px (x, y): [dh/dx, dh/dy] (plates are shaded by the bulge under them). */
  slope(x: number, y: number): [number, number] {
    const c = this.cell;
    const at = (px: number, py: number) => {
      const i = Math.round((px - this.x0) / c);
      const j = Math.round((py - this.y0) / c);
      if (i < 0 || j < 0 || i >= this.gw || j >= this.gh) return 0;
      return this.h[j * this.gw + i]!;
    };
    const e = c * 2;
    return [(at(x + e, y) - at(x - e, y)) / (2 * e), (at(x, y + e) - at(x, y - e)) / (2 * e)];
  }

  /** A punch's flex: a bend at (x, y) and a ring running out from it; amp in px. */
  wave(x: number, y: number, amp: number) {
    this.waveList.push({ x, y, t: 0, amp });
    if (this.waveList.length > MATERIAL.maxWaves) this.waveList.shift();
  }

  /** Shake the page (s: 0..1 of the full shake). */
  shake(s: number) {
    this.shakeT = 0;
    this.shakeAmp = Math.max(this.shakeAmp * 0.5, s);
  }

  /** Advance waves and shake; writes the shake offset into the view. */
  update(dt: number, v: View) {
    this.time += dt;
    for (const w of this.waveList) w.t += dt;
    // (gone once both the ring and the bend have died down)
    this.waveList = this.waveList.filter((w) => w.t < Math.max(3 / MATERIAL.waveDecay, 3 / MATERIAL.flexDecay));
    this.shakeT += dt;
    const k = this.shakeT < MATERIAL.shakeTime ? (1 - this.shakeT / MATERIAL.shakeTime) ** 2 * this.shakeAmp : 0;
    v.shakeX = k * MATERIAL.shake * Math.sin(this.time * 97);
    v.shakeY = k * MATERIAL.shake * Math.cos(this.time * 71) * 0.7;
  }

  /** Busy: something's moving (the loop can idle otherwise). */
  get busy() {
    return this.waveList.length > 0 || this.shakeT < MATERIAL.shakeTime;
  }

  draw(v: View) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.dirty) {
      const [i0, j0, i1, j1] = this.dirty;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.gw);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, i0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, j0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, i0, j0, i1 - i0 + 1, j1 - j0 + 1, gl.RED, gl.FLOAT, this.h);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      this.dirty = null;
    }
    gl.useProgram(this.program);
    setViewUniforms(gl, this.u, v);
    gl.uniform1i(this.u.uHeight!, 0);
    const c = this.cell;
    // texel centres sit on the grid points
    gl.uniform4f(this.u.uField!, this.x0 - c / 2, this.y0 - c / 2, this.gw * c, this.gh * c);
    const w = new Float32Array(MATERIAL.maxWaves * 4);
    this.waveList.forEach((x, i) => w.set([x.x, x.y, x.t, x.amp], i * 4));
    gl.uniform4fv(this.u.uWaves!, w);
    gl.uniform3fv(this.u.uBase!, MATERIAL.base);
    gl.uniform3fv(this.u.uLight!, MATERIAL.light);
    gl.uniform4f(this.u.uShade!, MATERIAL.diffuse, MATERIAL.specular, MATERIAL.shininess, MATERIAL.relief);
    gl.uniform4f(this.u.uWave!, MATERIAL.waveSpeed, MATERIAL.waveLength, MATERIAL.waveDecay, MATERIAL.flexRadius);
    gl.uniform3f(this.u.uFlex!, MATERIAL.flexFreq, MATERIAL.flexDecay, c);
    gl.uniform4f(this.u.uRest!, MATERIAL.sheen, MATERIAL.grain, MATERIAL.brighten, MATERIAL.occlusion);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
