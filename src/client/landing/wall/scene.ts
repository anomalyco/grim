// The renderer: hand-written WebGL2, one full-window canvas behind the page. Everything is in page px with z toward
// you (the wall's face is z = 0). A near-orthographic camera faces the wall from MATERIAL.distance, centred on the
// window, so z = 0 lands exactly on the page. Each frame something moves, the pieces refill four streams:
//   faces    shaded triangles (position, normal, colour), depth-tested
//   shadows  the outlines of lifted things, flattened onto the wall along the light, blurred, then laid on whatever
//            is at the wall's depth or behind it (never on the lifted things themselves)
//   ink      screen-space lines with an antialiased edge, depth-tested with a small bias so hidden edges stay hidden
import { Buf, compile, uniforms, type View, type Xf } from "./core.ts";
import { celGlsl, MATERIAL } from "./material.ts";

const PROJECT = `
uniform vec4 uView;  // scrollX, scrollY, window w, h (CSS px)
uniform vec3 uCam;   // jolt x, y (px), camera distance
uniform vec2 uOblique;
const float ZR = 4000.0;
vec4 project(vec3 p) {
  vec2 c = uView.xy + 0.5 * uView.zw;
  float w = max(0.05, (uCam.z - p.z) / uCam.z);
  vec2 q = p.xy + uOblique * p.z + uCam.xy - c;
  return vec4(q.x / (0.5 * uView.z), -q.y / (0.5 * uView.w), (-p.z / ZR) * w, w);
}`;

const FACE_VS = `#version 300 es
in vec3 aPos;
in vec3 aNrm;
in vec3 aCol;
out vec3 vN;
out vec3 vC;
out vec2 vS;
out float vZ;
uniform vec3 uLight;
${PROJECT}
void main() {
  gl_Position = project(aPos);
  vN = aNrm;
  vC = aCol;
  // where the light through this point meets the wall (on the shadow buffer)
  vec4 s = project(vec3(aPos.xy - uLight.xy / uLight.z * aPos.z, 0.0));
  vS = s.xy / s.w * 0.5 + 0.5;
  vZ = aPos.z;
}`;
const FACE_FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vC;
in vec2 vS;
in float vZ;
uniform sampler2D uShadow;
uniform vec4 uTint; // shadow colour (multiplied), strength (0: no shadows this frame)
out vec4 o;
${celGlsl()}
void main() {
  vec3 c = cel(vC, vN);
  if (uTint.a > 0.0) {
    // shadowed where something higher than this point is between it and the light
    vec2 s = texture(uShadow, vS).rg;
    float a = s.r * smoothstep(vZ + 5.0, vZ + 18.0, s.g * 255.0) * uTint.a;
    c *= 1.0 - a * (1.0 - uTint.rgb);
  }
  o = vec4(c, 1.0);
}`;

const LINE_VS = `#version 300 es
in vec3 aP;
in vec3 aQ;
in vec2 aSide;   // side (-1, 1), width (CSS px)
in vec4 aCol;    // rgb, alpha
out float vAcross;
out vec4 vCol;
uniform float uDpr;
uniform float uBias;
${PROJECT}
void main() {
  vec4 a = project(aP);
  vec4 b = project(aQ);
  vec2 half_ = 0.5 * uView.zw;
  vec2 ap = a.xy / a.w * half_;
  vec2 bp = b.xy / b.w * half_;
  vec2 d = bp - ap;
  float l = length(d);
  d = l > 1e-4 ? d / l : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  float w = abs(aSide.y);
  float h = 0.5 * w + 1.0 / uDpr;
  vec2 off = n * aSide.x * h - d * 0.5 * w;
  gl_Position = vec4((a.xy / a.w + off / half_) * a.w, (a.z / a.w - uBias) * a.w, a.w);
  vAcross = aSide.x * sign(aSide.y) * h / max(h - 0.5 / uDpr, 1e-3);
  vCol = aCol;
}`;
const LINE_FS = `#version 300 es
precision highp float;
in float vAcross;
in vec4 vCol;
out vec4 o;
void main() {
  float a = clamp((1.0 - abs(vAcross)) / max(fwidth(vAcross), 1e-4), 0.0, 1.0) * vCol.a;
  o = vec4(vCol.rgb * a, a);
}`;

const SHADOW_VS = `#version 300 es
in vec3 aPos;
in float aA;
out float vA;
out float vZ;
uniform vec3 uLight;
${PROJECT}
void main() {
  float z = max(aPos.z, 0.0);
  gl_Position = project(vec3(aPos.xy - uLight.xy / uLight.z * z, 0.0));
  gl_Position.z = 0.0;
  vA = aA;
  vZ = z;
}`;
// r: how much shadow, g: the height (/255 px) of what casts it
const SHADOW_FS = `#version 300 es
precision mediump float;
in float vA;
in float vZ;
out vec4 o;
void main() { o = vec4(vA, min(vZ / 255.0, 1.0), 0.0, 1.0); }`;

const FULL_VS = `#version 300 es
uniform float uZ;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, uZ, 1.0);
}`;
const BLUR_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uStep;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uTex, 0));
  // r blurred; g (the caster's height) spread to the widest the blur reaches
  vec2 c = texture(uTex, uv).rg;
  vec2 a1 = texture(uTex, uv + uStep * 1.3846).rg;
  vec2 b1 = texture(uTex, uv - uStep * 1.3846).rg;
  vec2 a2 = texture(uTex, uv + uStep * 3.2308).rg;
  vec2 b2 = texture(uTex, uv - uStep * 3.2308).rg;
  float s = c.r * 0.2270 + (a1.r + b1.r) * 0.3162 + (a2.r + b2.r) * 0.0703;
  float g = max(c.g, max(max(a1.g, b1.g), max(a2.g, b2.g)));
  o = vec4(s, g, 0.0, 1.0);
}`;
const COMPOSITE_FS = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uSize;
uniform vec4 uTint; // rgb, strength
out vec4 o;
void main() {
  // (only on the bare wall, which is at z = 0: anything above it shades it)
  vec2 s = texture(uTex, gl_FragCoord.xy / uSize).rg;
  float a = s.r * smoothstep(3.0, 9.0, s.g * 255.0) * uTint.a;
  o = vec4(1.0 - a * (1.0 - uTint.rgb), 1.0);
}`;

const FACE = 9;
const LINE = 12;
const SHADOW = 4;
const ZR = 4000;

/** The streams the pieces fill, and the drawing. */
export class Scene {
  readonly faces = new Buf(1 << 16);
  readonly ink = new Buf(1 << 15);
  readonly shadows = new Buf(1 << 14);
  private face: Prog;
  private line: Prog;
  private shadow: Prog;
  private blur: Prog;
  private comp: Prog;
  private faceVao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private shadowVao: WebGLVertexArrayObject;
  private faceBuf: WebGLBuffer;
  private lineBuf: WebGLBuffer;
  private shadowBuf: WebGLBuffer;
  private tex: WebGLTexture[] = [];
  private fbo: WebGLFramebuffer[] = [];
  private fw = 0;
  private fh = 0;
  private emptyVao: WebGLVertexArrayObject;
  /** the shadow buffer's resolution against the window's (CSS px) */
  private shadowScale: number;
  private uploaded = false;
  private light: [number, number, number];

  constructor(private gl: WebGL2RenderingContext, low: boolean) {
    const L = MATERIAL.light;
    const l = Math.hypot(...L);
    this.light = [L[0] / l, L[1] / l, L[2] / l];
    this.shadowScale = low ? 0.25 : 0.5;
    const U = ["uView", "uCam", "uOblique"];
    this.face = prog(gl, FACE_VS, FACE_FS, [...U, "uLight", "uShadow", "uTint"]);
    this.line = prog(gl, LINE_VS, LINE_FS, [...U, "uDpr", "uBias"]);
    this.shadow = prog(gl, SHADOW_VS, SHADOW_FS, [...U, "uLight"]);
    this.blur = prog(gl, FULL_VS, BLUR_FS, ["uTex", "uStep", "uZ"]);
    this.comp = prog(gl, FULL_VS, COMPOSITE_FS, ["uTex", "uSize", "uTint", "uZ"]);
    [this.faceVao, this.faceBuf] = vao(gl, this.face.p, FACE, [["aPos", 3], ["aNrm", 3], ["aCol", 3]]);
    [this.lineVao, this.lineBuf] = vao(gl, this.line.p, LINE, [["aP", 3], ["aQ", 3], ["aSide", 2], ["aCol", 4]]);
    [this.shadowVao, this.shadowBuf] = vao(gl, this.shadow.p, SHADOW, [["aPos", 3], ["aA", 1]]);
    this.emptyVao = gl.createVertexArray()!;
  }

  clear() {
    this.faces.clear();
    this.ink.clear();
    this.shadows.clear();
    this.uploaded = false;
  }

  /** A flat-shaded triangle (world points), with the face's normal and colour. */
  tri(a: V3, b: V3, c: V3, n: V3, col: V3) {
    const f = this.faces;
    f.room(FACE * 3);
    const d = f.data;
    for (const p of [a, b, c]) {
      const o = f.n;
      d[o] = p[0];
      d[o + 1] = p[1];
      d[o + 2] = p[2];
      d[o + 3] = n[0];
      d[o + 4] = n[1];
      d[o + 5] = n[2];
      d[o + 6] = col[0];
      d[o + 7] = col[1];
      d[o + 8] = col[2];
      f.n += FACE;
    }
  }

  /** An ink segment (world points), `w` CSS px wide. */
  seg(p: V3, q: V3, w: number, col: V3, alpha = 1) {
    const b = this.ink;
    b.room(LINE * 6);
    const d = b.data;
    const v = (s: V3, e: V3, side: number, flip = 1) => {
      const o = b.n;
      d[o] = s[0];
      d[o + 1] = s[1];
      d[o + 2] = s[2];
      d[o + 3] = e[0];
      d[o + 4] = e[1];
      d[o + 5] = e[2];
      d[o + 6] = side;
      d[o + 7] = w * flip;
      d[o + 8] = col[0];
      d[o + 9] = col[1];
      d[o + 10] = col[2];
      d[o + 11] = alpha;
      b.n += LINE;
    };
    // (seen from q, left is the other side: q's corners swap sides, and a negative width says so for the edge fade)
    v(p, q, 1);
    v(p, q, -1);
    v(q, p, -1, -1);
    v(q, p, -1, -1);
    v(p, q, -1);
    v(q, p, 1, -1);
  }

  /** A shadow-casting triangle (world points; flattened onto the wall along the light when drawn). */
  shadowTri(a: V3, b: V3, c: V3, alpha: number) {
    const s = this.shadows;
    s.room(SHADOW * 3);
    const d = s.data;
    for (const p of [a, b, c]) {
      const o = s.n;
      d[o] = p[0];
      d[o + 1] = p[1];
      d[o + 2] = p[2];
      d[o + 3] = alpha;
      s.n += SHADOW;
    }
  }

  render(v: View, canvas: HTMLCanvasElement) {
    const gl = this.gl;
    const w = Math.round(v.vw * v.dpr);
    const h = Math.round(v.vh * v.dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = v.vw + "px";
      canvas.style.height = v.vh + "px";
    }
    if (!this.uploaded) {
      for (const [buf, b] of [[this.faceBuf, this.faces], [this.lineBuf, this.ink], [this.shadowBuf, this.shadows]] as const) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n), gl.DYNAMIC_DRAW);
      }
      this.uploaded = true;
    }
    const view = (p: Prog) => {
      gl.useProgram(p.p);
      gl.uniform4f(p.u.uView!, v.sx, v.sy, v.vw, v.vh);
      gl.uniform3f(p.u.uCam!, v.shakeX, v.shakeY, MATERIAL.distance);
      gl.uniform2f(p.u.uOblique!, ...MATERIAL.oblique);
    };

    // the shadows first, into their own buffer
    const hasShadow = this.shadows.n > 0;
    if (hasShadow) {
      const sw = Math.max(1, Math.round(v.vw * this.shadowScale));
      const sh = Math.max(1, Math.round(v.vh * this.shadowScale));
      this.targets(sw, sh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]!);
      gl.viewport(0, 0, sw, sh);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      view(this.shadow);
      gl.uniform3f(this.shadow.u.uLight!, ...this.light);
      gl.bindVertexArray(this.shadowVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.shadows.n / SHADOW);
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
      // blurred twice each way
      gl.useProgram(this.blur.p);
      gl.uniform1f(this.blur.u.uZ!, 0);
      gl.bindVertexArray(this.emptyVao);
      const r = (MATERIAL.shadowBlur * this.shadowScale) / 3;
      for (let i = 0; i < 4; i++) {
        const src = i % 2;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1 - src]!);
        gl.bindTexture(gl.TEXTURE_2D, this.tex[src]!);
        gl.uniform1i(this.blur.u.uTex!, 0);
        gl.uniform2f(this.blur.u.uStep!, src === 0 ? r / sw : 0, src === 0 ? 0 : r / sh);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    const P = MATERIAL.paper;
    gl.clearColor(P[0], P[1], P[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    const T = MATERIAL.shadowTint;
    if (this.faces.n) {
      view(this.face);
      gl.uniform3f(this.face.u.uLight!, ...this.light);
      gl.uniform4f(this.face.u.uTint!, T[0], T[1], T[2], hasShadow ? MATERIAL.shadow : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hasShadow ? this.tex[0]! : null);
      gl.uniform1i(this.face.u.uShadow!, 0);
      gl.bindVertexArray(this.faceVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.faces.n / FACE);
    }
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (hasShadow) {
      // on the bare wall: where nothing's been drawn (the faces shade themselves)
      gl.depthFunc(gl.EQUAL);
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      gl.useProgram(this.comp.p);
      gl.uniform1f(this.comp.u.uZ!, 1);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[0]!);
      gl.uniform1i(this.comp.u.uTex!, 0);
      gl.uniform2f(this.comp.u.uSize!, w, h);
      gl.uniform4f(this.comp.u.uTint!, T[0], T[1], T[2], MATERIAL.shadow);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (this.ink.n) {
      gl.depthFunc(gl.LEQUAL);
      view(this.line);
      gl.uniform1f(this.line.u.uDpr!, v.dpr);
      gl.uniform1f(this.line.u.uBias!, 0.8 / ZR);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.ink.n / LINE);
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  private targets(w: number, h: number) {
    const gl = this.gl;
    if (this.fw === w && this.fh === h) return;
    this.fw = w;
    this.fh = h;
    for (const t of this.tex) gl.deleteTexture(t);
    for (const f of this.fbo) gl.deleteFramebuffer(f);
    this.tex = [];
    this.fbo = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.tex.push(t);
      this.fbo.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}

export type V3 = [number, number, number] | number[];

interface Prog {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

function prog(gl: WebGL2RenderingContext, vs: string, fs: string, names: string[]): Prog {
  const p = compile(gl, vs, fs);
  return { p, u: uniforms(gl, p, names) };
}

function vao(gl: WebGL2RenderingContext, p: WebGLProgram, stride: number, attrs: [string, number][]) {
  const a = gl.createVertexArray()!;
  const b = gl.createBuffer()!;
  gl.bindVertexArray(a);
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  let off = 0;
  for (const [name, size] of attrs) {
    const loc = gl.getAttribLocation(p, name);
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4);
    }
    off += size;
  }
  gl.bindVertexArray(null);
  return [a, b] as const;
}

/** Apply a rigid transform to a point. */
export function xf(x: Xf, px: number, py: number, pz: number): V3 {
  const r = x.r;
  return [
    r[0]! * px + r[1]! * py + r[2]! * pz + x.t[0],
    r[3]! * px + r[4]! * py + r[5]! * pz + x.t[1],
    r[6]! * px + r[7]! * py + r[8]! * pz + x.t[2],
  ];
}

/** Rotate a direction. */
export function xfDir(x: Xf, dx: number, dy: number, dz: number): V3 {
  const r = x.r;
  return [r[0]! * dx + r[1]! * dy + r[2]! * dz, r[3]! * dx + r[4]! * dy + r[5]! * dz, r[6]! * dx + r[7]! * dy + r[8]! * dz];
}
