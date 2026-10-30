// Breaking: a fragment cracked all round (cracks.ts) is shoved out of the wall from behind and falls: it pops toward
// you, spins, tips over (squashed along one axis, showing its edge), drops under gravity with its shadow sliding away
// on the wall, bounces off the bottom of the window and fades. A spray of small chips goes with it. Behind it, the
// hole (hole.ts) shows the dark.
import { gauss, rand, type Batch, type View } from "./core.ts";
import type { Cell } from "./cracks.ts";
import { MATERIAL } from "./material.ts";

export const DEBRIS = {
  /** px/s² */
  gravity: 1700,
  /** the shove from behind: toward you (px/s), outward from the hole (px/s), upward kick (px/s) */
  push: [90, 240] as const,
  out: [20, 110] as const,
  up: [20, 140] as const,
  /** spin (rad/s, one sd) and tipping-over speed (rad/s, one sd) */
  spin: 2.2,
  tip: 3,
  /** how much nearer pieces grow (per px toward you) */
  perspective: 1 / 700,
  /** the plastic's thickness (px), as seen on a tipped piece */
  thickness: 7,
  /** bounces off the bottom of the window: restitution, and how many before it just slides and fades */
  bounce: 0.32,
  bounces: 2,
  /** seconds a piece stays after it lands, then fades over `fade` s */
  linger: 0.5,
  fade: 0.6,
  /** the shadow on the wall: alpha, and offset per px toward you */
  shadow: 0.2,
  shadowShift: [0.1, 0.16] as const,
  /** chips per break, and their size (px) */
  chips: [4, 9] as const,
  chipSize: [2, 6] as const,
  /** at most this many falling at once (older ones vanish) */
  max: 24,
  maxLow: 6,
};

interface Piece {
  pts: number[];
  tris: number[];
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ang: number;
  va: number;
  tilt: number;
  vt: number;
  floor: number;
  /** how far it reaches from its middle (px) */
  rad: number;
  bounces: number;
  landed: number;
  alpha: number;
  chip: boolean;
}

export class Debris {
  private pieces: Piece[] = [];
  private max: number;

  constructor(low: boolean) {
    this.max = low ? DEBRIS.maxLow : DEBRIS.max;
  }

  /** Break `c` out of the wall; (hx, hy): the hole's middle (pieces fly outward from it). */
  fall(c: Cell, hx: number, hy: number, v: View) {
    const pts: number[] = [];
    let rad = 0;
    for (let i = 0; i < c.poly.length; i += 2) {
      const x = c.poly[i]! - c.cx;
      const y = c.poly[i + 1]! - c.cy;
      pts.push(x, y);
      rad = Math.max(rad, Math.hypot(x, y));
    }
    let dx = c.cx - hx;
    let dy = c.cy - hy;
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const floor = v.sy + v.vh;
    const out = rand(...DEBRIS.out);
    this.add({
      pts, tris: c.tris, x: c.cx, y: c.cy, z: 0,
      vx: dx * out + gauss() * 20, vy: dy * out * 0.5 - rand(...DEBRIS.up), vz: rand(...DEBRIS.push),
      ang: 0, va: gauss() * DEBRIS.spin, tilt: 0, vt: gauss() * DEBRIS.tip,
      floor, rad, bounces: 0, landed: 0, alpha: 1, chip: false,
    });
    const n = Math.round(rand(...DEBRIS.chips));
    for (let i = 0; i < n; i++) {
      const k = Math.floor(Math.random() * (c.poly.length / 2));
      const s = rand(...DEBRIS.chipSize);
      const a = Math.random() * Math.PI * 2;
      const chip = [0, -s, s * 0.9, s * 0.6, -s * 0.8, s * 0.7].map((q) => q * rand(0.6, 1.2));
      this.add({
        pts: chip, tris: [0, 1, 2],
        x: c.poly[k * 2]!, y: c.poly[k * 2 + 1]!, z: 0,
        vx: dx * rand(40, 200) + gauss() * 60, vy: -rand(60, 260), vz: rand(100, 300),
        ang: a, va: gauss() * 8, tilt: 0, vt: gauss() * 6,
        floor, rad: s, bounces: 0, landed: 0, alpha: 1, chip: true,
      });
    }
  }

  private add(p: Piece) {
    this.pieces.push(p);
    while (this.pieces.length > this.max * 3) this.pieces.shift();
    let big = this.pieces.filter((q) => !q.chip);
    while (big.length > this.max) {
      this.pieces.splice(this.pieces.indexOf(big[0]!), 1);
      big = big.slice(1);
    }
  }

  update(dt: number) {
    for (const p of this.pieces) {
      p.vy += DEBRIS.gravity * dt;
      p.vz *= Math.exp(-dt * 1.2);
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.ang += p.va * dt;
      p.tilt += p.vt * dt;
      const s = 1 + p.z * DEBRIS.perspective;
      const bottom = p.floor - p.rad * s * 0.6;
      if (p.y > bottom) {
        p.y = bottom;
        if (p.bounces < DEBRIS.bounces && p.vy > 150) {
          p.vy = -p.vy * DEBRIS.bounce;
          p.va *= 0.6;
          p.vt *= 0.5;
          p.vx *= 0.7;
          p.bounces++;
        } else {
          p.vy = 0;
          p.vx *= Math.exp(-dt * 6);
          p.va *= Math.exp(-dt * 6);
          p.vt *= Math.exp(-dt * 8);
          p.landed += dt;
        }
      }
      if (p.landed > DEBRIS.linger) p.alpha -= dt / DEBRIS.fade;
    }
    this.pieces = this.pieces.filter((p) => p.alpha > 0 && p.y < p.floor + 400);
  }

  get busy() {
    return this.pieces.length > 0;
  }

  draw(b: Batch, _v: View) {
    const base = MATERIAL.base;
    for (const p of this.pieces) {
      const s = 1 + p.z * DEBRIS.perspective;
      const ca = Math.cos(p.ang);
      const sa = Math.sin(p.ang);
      const squash = Math.cos(p.tilt);
      // tipped over: squashed along y (before the spin), so its thickness shows below or above
      const out: number[] = [];
      for (let i = 0; i < p.pts.length; i += 2) {
        const x = p.pts[i]!;
        const y = p.pts[i + 1]! * squash;
        out.push(p.x + (x * ca - y * sa) * s, p.y + (x * sa + y * ca) * s);
      }
      const a = p.alpha;
      if (!p.chip) {
        const sx = p.z * DEBRIS.shadowShift[0] + 3;
        const sy = p.z * DEBRIS.shadowShift[1] + 4;
        const sh = DEBRIS.shadow * a / (1 + p.z / 300);
        b.poly(out, p.tris, [0, 0, 0, sh * 0.6], sx * 1.3, sy * 1.3);
        b.poly(out, p.tris, [0, 0, 0, sh * 0.6], sx, sy);
      }
      // the edge: the same outline pushed along the thickness, under the face
      const t = DEBRIS.thickness * s * Math.sin(p.tilt);
      const ex = -sa * t;
      const ey = ca * t;
      const side = 0.72 + 0.08 * Math.sign(t);
      b.poly(out, p.tris, [base[0]! * side, base[1]! * side, base[2]! * side, a], ex, ey);
      b.poly(out, p.tris, [base[0]! * side, base[1]! * side, base[2]! * side, a], ex / 2, ey / 2);
      // the face: brighter tipped toward the light, darker away
      const shade = 0.985 + 0.03 * Math.sin(p.tilt + 0.6) - 0.03 * (1 - Math.abs(squash));
      b.poly(out, p.tris, [base[0]! * shade, base[1]! * shade, base[2]! * shade, a]);
      if (!p.chip) {
        const n = out.length;
        for (let i = 0; i < n; i += 2) {
          const j = (i + 2) % n;
          b.line(out[i]!, out[i + 1]!, out[j]!, out[j + 1]!, 0.6, [0.3, 0.3, 0.32, 0.35 * a]);
        }
      }
    }
  }
}
