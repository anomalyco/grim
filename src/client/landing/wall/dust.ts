// Dust and crumbs: what a punch knocks out of cracked drywall. Puffs of gypsum dust bloom from the cracks, drift and
// settle; crumbs (small chips of board and paint) spit out toward you, tumble and fall. Drawn over the wall and the
// plates (they're in front of it), under the text.
import { gauss, rand, type Batch } from "./core.ts";
import { MATERIAL } from "./material.ts";

export const DUST = {
  /** a puff: start and end radius (px), life (s), darkness (alpha), drift (px/s) */
  puffRadius: [6, 16] as const,
  puffGrow: [2.5, 4.5] as const,
  puffLife: [0.9, 2] as const,
  puffAlpha: 0.22,
  puffDrift: 35,
  /** puffs settle down (px/s²) */
  puffFall: 30,
  /** crumbs: size (px), speed out (px/s), toward you (px/s), gravity (px/s²) */
  crumbSize: [1.2, 4.5] as const,
  crumbSpeed: [40, 220] as const,
  crumbOut: [60, 260] as const,
  gravity: 1500,
  /** crumbs land at the bottom of the window and fade (s) */
  crumbFade: 0.6,
  /** at most this many of each at once */
  maxPuffs: 120,
  maxCrumbs: 220,
};

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r0: number;
  r1: number;
  t: number;
  life: number;
  a: number;
  shade: number;
}

interface Crumb {
  pts: number[];
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ang: number;
  va: number;
  floor: number;
  landed: number;
  shade: number;
}

export class Dust {
  private puffs: Puff[] = [];
  private crumbs: Crumb[] = [];

  /** A puff of dust at (x, y), `n` blooms, strength k (0..1+). */
  puff(x: number, y: number, n: number, k = 1, spread = 20) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(0.3, 1) * DUST.puffDrift * k;
      const r0 = rand(...DUST.puffRadius) * (0.6 + 0.4 * k);
      this.puffs.push({
        x: x + gauss() * spread, y: y + gauss() * spread, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 10,
        r0, r1: r0 * rand(...DUST.puffGrow), t: 0, life: rand(...DUST.puffLife), a: DUST.puffAlpha * rand(0.6, 1.1) * Math.min(1.4, k),
        shade: rand(0.82, 0.93),
      });
    }
    if (this.puffs.length > DUST.maxPuffs) this.puffs.splice(0, this.puffs.length - DUST.maxPuffs);
  }

  /** `n` crumbs spat out from round (x, y); floor: page y where they land (the window's bottom). */
  spit(x: number, y: number, n: number, floor: number, spread = 25, k = 1) {
    for (let i = 0; i < n; i++) {
      const s = rand(...DUST.crumbSize) * (0.7 + 0.5 * k);
      const m = Math.round(rand(3, 5));
      const pts: number[] = [];
      for (let j = 0; j < m; j++) {
        const a = (j / m) * Math.PI * 2 + rand(-0.4, 0.4);
        const r = s * rand(0.5, 1);
        pts.push(Math.cos(a) * r, Math.sin(a) * r);
      }
      const a = Math.random() * Math.PI * 2;
      const sp = rand(...DUST.crumbSpeed) * k;
      this.crumbs.push({
        pts, x: x + gauss() * spread, y: y + gauss() * spread, z: 0,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(40, 160), vz: rand(...DUST.crumbOut),
        ang: Math.random() * 6, va: gauss() * 10, floor, landed: 0, shade: rand(0.82, 1),
      });
    }
    if (this.crumbs.length > DUST.maxCrumbs) this.crumbs.splice(0, this.crumbs.length - DUST.maxCrumbs);
  }

  update(dt: number) {
    for (const p of this.puffs) {
      p.t += dt;
      const drag = Math.exp(-dt * 2.2);
      p.vx *= drag;
      p.vy = p.vy * drag + DUST.puffFall * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.puffs = this.puffs.filter((p) => p.t < p.life);
    for (const c of this.crumbs) {
      if (c.landed > 0) {
        c.landed += dt;
        continue;
      }
      c.vy += DUST.gravity * dt;
      c.vz *= Math.exp(-dt * 1.5);
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.z += c.vz * dt;
      c.ang += c.va * dt;
      if (c.y > c.floor) {
        c.y = c.floor;
        c.landed = 1e-6;
      }
    }
    this.crumbs = this.crumbs.filter((c) => c.landed < DUST.crumbFade);
  }

  get busy() {
    return this.puffs.length > 0 || this.crumbs.length > 0;
  }

  draw(b: Batch) {
    const base = MATERIAL.base;
    for (const c of this.crumbs) {
      const s = 1 + c.z / 700;
      const ca = Math.cos(c.ang);
      const sa = Math.sin(c.ang);
      const a = c.landed > 0 ? 1 - c.landed / DUST.crumbFade : 1;
      const out: number[] = [];
      for (let i = 0; i < c.pts.length; i += 2) {
        const x = c.pts[i]! * s;
        const y = c.pts[i + 1]! * s * Math.abs(Math.cos(c.ang * 0.7));
        out.push(c.x + x * ca - y * sa, c.y + x * sa + y * ca);
      }
      const tris: number[] = [];
      for (let i = 1; i + 1 < out.length / 2; i++) tris.push(0, i, i + 1);
      // a little shadow, then the chip (one side paint, the other gypsum, as it tumbles)
      b.poly(out, tris, [0, 0, 0, 0.18 * a], 1 + c.z * 0.02, 1.5 + c.z * 0.03);
      const sh = c.shade * (Math.sin(c.ang) > 0 ? 1 : 0.86);
      b.poly(out, tris, [base[0]! * sh * 0.97, base[1]! * sh * 0.96, base[2]! * sh * 0.93, a]);
    }
    for (const p of this.puffs) {
      const k = p.t / p.life;
      const r = p.r0 + (p.r1 - p.r0) * (1 - (1 - k) ** 2);
      // fades in fast, out slowly
      const a = p.a * Math.min(1, k * 8) * (1 - k) ** 1.5;
      b.disc(p.x, p.y, r, [p.shade, p.shade * 0.985, p.shade * 0.96, a]);
    }
  }
}
