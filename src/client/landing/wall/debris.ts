// What comes off the wall, as rigid bodies: plates knocked out at the breakthrough (they leave from where they were
// tipped to, come toward you, tumble under gravity with their broken sides showing and their shadow on the wall,
// and fall off the bottom of the window), and the crumbs each punch spits out of the cracks.
import { axisAngle, gauss, mul3, orthonormalize, rand, type View } from "./core.ts";
import { MATERIAL } from "./material.ts";
import { drawSlab, type Slab } from "./plates.ts";
import type { Scene } from "./scene.ts";
import type { Xf } from "./core.ts";

export const DEBRIS = {
  /** px/s² down the page */
  gravity: 1900,
  /** a knocked-out plate: toward you (px/s), out from the hole's middle (px/s), up (px/s), spin (rad/s) */
  toward: [180, 320] as const,
  out: [40, 140] as const,
  up: [60, 220] as const,
  spin: [2.5, 6] as const,
  /** its shadow fades as it comes away from the wall: alpha = exp(-z / fade) */
  shadowFade: 260,
  /** crumbs: how many a punch spits, their size (px), thickness (px), speed toward you, and sideways */
  crumbs: [3, 6] as const,
  crumbSize: [2.2, 5.5] as const,
  crumbDepth: [2.5, 5] as const,
  crumbToward: [140, 380] as const,
  crumbSide: 170,
  crumbSpin: 14,
  /** at most this many bodies at once (crumbs are dropped first) */
  max: 140,
};

interface Body {
  slab: Slab;
  /** the slab's own middle, at rest */
  c: [number, number, number];
  r: number[];
  p: [number, number, number];
  v: [number, number, number];
  w: [number, number, number];
  crumb: boolean;
  /** half its size (px), for culling */
  ext: number;
  age: number;
}

export class Debris {
  private list: Body[] = [];

  get busy() {
    return this.list.length > 0;
  }

  get count() {
    return this.list.length;
  }

  clear() {
    this.list = [];
  }

  /** A plate knocked out, leaving from where it is (`x`), its middle at (cx, cy), the hole's middle at (hx, hy);
   *  `away` is the way it was tipping. */
  knock(slab: Slab, x: Xf, cx: number, cy: number, hx: number, hy: number, away: [number, number]) {
    const c: [number, number, number] = [cx, cy, -slab.depth / 2];
    const r = [...x.r];
    const p: [number, number, number] = [
      r[0]! * c[0] + r[1]! * c[1] + r[2]! * c[2] + x.t[0],
      r[3]! * c[0] + r[4]! * c[1] + r[5]! * c[2] + x.t[1],
      r[6]! * c[0] + r[7]! * c[1] + r[8]! * c[2] + x.t[2],
    ];
    let ox = cx - hx;
    let oy = cy - hy;
    const ol = Math.hypot(ox, oy);
    if (ol < 1) {
      const a = Math.random() * Math.PI * 2;
      ox = Math.cos(a);
      oy = Math.sin(a);
    } else {
      ox /= ol;
      oy /= ol;
    }
    const out = rand(...DEBRIS.out);
    const v: [number, number, number] = [ox * out, oy * out - rand(...DEBRIS.up), rand(...DEBRIS.toward)];
    // keep tipping the way it was (about the hinge's direction), plus a little of anything
    const s = rand(...DEBRIS.spin);
    const w: [number, number, number] = [away[1] * s + gauss() * 1.2, -away[0] * s + gauss() * 1.2, gauss() * 1.8];
    this.add({ slab, c, r, p, v, w, crumb: false, ext: Math.sqrt(polyArea(slab.poly)) * 0.8, age: 0 });
  }

  /** Crumbs out of the wall at (x, y), thrown roughly along (dx, dy). */
  crumbs(pts: [number, number][], dx = 0, dy = 0, n = Math.round(rand(...DEBRIS.crumbs)), scale = 1, wait = 0) {
    if (!pts.length) return;
    for (let i = 0; i < n; i++) {
      const [x, y] = pts[Math.floor(Math.random() * pts.length)]!;
      const size = rand(...DEBRIS.crumbSize) * scale;
      const k = 4 + Math.floor(Math.random() * 3);
      const poly: number[] = [];
      const a0 = Math.random() * Math.PI * 2;
      for (let j = 0; j < k; j++) {
        const a = a0 + (j / k) * Math.PI * 2 + rand(-0.35, 0.35) / k * 6;
        const d = size * rand(0.6, 1.1);
        poly.push(x + Math.cos(a) * d, y + Math.sin(a) * d);
      }
      const tris: number[] = [];
      for (let j = 1; j < k - 1; j++) tris.push(0, j, j + 1);
      const normals: number[] = [];
      for (let j = 0; j < k; j++) {
        const q = (j + 1) % k;
        const ex = poly[q * 2]! - poly[j * 2]!;
        const ey = poly[q * 2 + 1]! - poly[j * 2 + 1]!;
        const l = Math.hypot(ex, ey) || 1;
        normals.push(ey / l, -ex / l);
      }
      const depth = rand(...DEBRIS.crumbDepth) * Math.sqrt(scale);
      const slab: Slab = { poly, tris, normals, corners: [], depth };
      const side = DEBRIS.crumbSide;
      this.add({
        slab,
        c: [x, y, -depth / 2],
        r: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        p: [x, y, 1],
        v: [dx * side + gauss() * side * 0.6, dy * side + gauss() * side * 0.6 - rand(40, 160), rand(...DEBRIS.crumbToward)],
        w: [gauss() * DEBRIS.crumbSpin, gauss() * DEBRIS.crumbSpin, gauss() * DEBRIS.crumbSpin],
        crumb: scale < 1.5,
        ext: size,
        age: -wait,
      });
    }
  }

  private add(b: Body) {
    this.list.push(b);
    if (this.list.length > DEBRIS.max) {
      const i = this.list.findIndex((x) => x.crumb);
      this.list.splice(i >= 0 ? i : 0, 1);
    }
  }

  update(dt: number, v: View) {
    const D = MATERIAL.distance;
    for (const b of this.list) {
      b.age += dt;
      if (b.age < 0) continue;
      b.v[1] += DEBRIS.gravity * dt;
      b.p[0] += b.v[0] * dt;
      b.p[1] += b.v[1] * dt;
      b.p[2] = Math.min(D * 0.7, b.p[2] + b.v[2] * dt);
      const wl = Math.hypot(...b.w);
      if (wl > 1e-6) {
        const r = mul3(axisAngle(b.w[0] / wl, b.w[1] / wl, b.w[2] / wl, wl * dt), b.r);
        orthonormalize(r);
        b.r = r;
      }
    }
    // gone once it's below the window (seen in perspective)
    const cy = v.sy + v.vh / 2;
    this.list = this.list.filter((b) => {
      const k = D / (D - b.p[2]);
      const sy = cy + (b.p[1] + MATERIAL.oblique[1] * b.p[2] - b.ext - cy) * k;
      return sy < v.sy + v.vh + 40 && b.age < 6;
    });
  }

  draw(scene: Scene) {
    for (const b of this.list) {
      if (b.age < 0) continue;
      const r = b.r;
      const t: [number, number, number] = [
        b.p[0] - (r[0]! * b.c[0] + r[1]! * b.c[1] + r[2]! * b.c[2]),
        b.p[1] - (r[3]! * b.c[0] + r[4]! * b.c[1] + r[5]! * b.c[2]),
        b.p[2] - (r[6]! * b.c[0] + r[7]! * b.c[1] + r[8]! * b.c[2]),
      ];
      const shadow = b.crumb ? 0 : Math.exp(-Math.max(0, b.p[2]) / DEBRIS.shadowFade);
      drawSlab(scene, b.slab, { r, t }, {
        solid: true,
        ink: b.crumb ? 1 : MATERIAL.inkEdge,
        inkBack: b.crumb ? 0 : MATERIAL.inkBack,
        shadow,
      });
    }
  }
}

function polyArea(p: number[]) {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2]! * p[j * 2 + 1]! - p[j * 2]! * p[i * 2 + 1]!;
  }
  return Math.abs(a / 2);
}
